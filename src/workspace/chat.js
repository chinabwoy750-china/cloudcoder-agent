import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspace, safeSegment } from './manager.js';
import { getPostgresPool, isPostgresConfigured } from '../storage/postgres.js';

const CHAT_FILE = '.universal-modder-chat.json';
const MAX_MESSAGES = 120;

function sanitizeMessages(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m?.role === 'user' || m?.role === 'agent' || m?.role === 'tool' ? m.role : 'agent',
      text: String(m?.text || '').slice(0, 20000),
      html: m?.html ? String(m.html).slice(0, 40000) : undefined,
      at: m?.at || new Date().toISOString(),
    }))
    .filter((m) => m.text || m.html);
}

async function readFromDisk(workspaceId) {
  try {
    const dir = await resolveWorkspace(safeSegment(workspaceId));
    const file = path.join(dir, CHAT_FILE);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return sanitizeMessages(raw?.messages || raw);
  } catch {
    return [];
  }
}

async function writeToDisk(workspaceId, messages) {
  try {
    const dir = await resolveWorkspace(safeSegment(workspaceId));
    const file = path.join(dir, CHAT_FILE);
    const cleaned = sanitizeMessages(messages);
    await fs.writeFile(
      file,
      JSON.stringify({ updatedAt: new Date().toISOString(), messages: cleaned }, null, 2),
      { mode: 0o600 },
    );
    return cleaned;
  } catch {
    return sanitizeMessages(messages);
  }
}

async function readFromPostgres(workspaceId) {
  const db = getPostgresPool();
  if (!db) return null;
  try {
    const { rows } = await db.query(
      'SELECT messages FROM workspace_chat WHERE workspace_id=$1 LIMIT 1',
      [safeSegment(workspaceId)],
    );
    if (!rows.length) return null;
    return sanitizeMessages(rows[0].messages);
  } catch {
    return null;
  }
}

async function writeToPostgres(workspaceId, messages) {
  const db = getPostgresPool();
  if (!db) return null;
  const cleaned = sanitizeMessages(messages);
  try {
    await db.query(
      `INSERT INTO workspace_chat (workspace_id, messages, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         messages = EXCLUDED.messages,
         updated_at = NOW()`,
      [safeSegment(workspaceId), JSON.stringify(cleaned)],
    );
    return cleaned;
  } catch (err) {
    // Table may not exist yet on old deploys — ignore and use disk
    console.warn('[chat] postgres write failed:', err.message);
    return null;
  }
}

export async function readWorkspaceChat(workspaceId) {
  // Prefer durable Postgres (survives Render restarts + cross-device)
  if (isPostgresConfigured()) {
    const fromDb = await readFromPostgres(workspaceId);
    if (fromDb && fromDb.length) return fromDb;
  }
  const fromDisk = await readFromDisk(workspaceId);
  // Backfill DB when disk has data but DB was empty
  if (fromDisk.length && isPostgresConfigured()) {
    writeToPostgres(workspaceId, fromDisk).catch(() => {});
  }
  return fromDisk;
}

export async function writeWorkspaceChat(workspaceId, messages) {
  const cleaned = sanitizeMessages(messages);
  // Always try Postgres first for durability
  if (isPostgresConfigured()) {
    const saved = await writeToPostgres(workspaceId, cleaned);
    if (saved) {
      // Best-effort mirror to disk for local tools
      writeToDisk(workspaceId, cleaned).catch(() => {});
      return saved;
    }
  }
  return writeToDisk(workspaceId, cleaned);
}

export async function appendWorkspaceChat(workspaceId, message) {
  const current = await readWorkspaceChat(workspaceId);
  current.push(message);
  return writeWorkspaceChat(workspaceId, current);
}
