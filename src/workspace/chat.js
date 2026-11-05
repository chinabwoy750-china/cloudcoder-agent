import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspace, safeSegment } from './manager.js';

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

export async function readWorkspaceChat(workspaceId) {
  const dir = await resolveWorkspace(safeSegment(workspaceId));
  const file = path.join(dir, CHAT_FILE);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return sanitizeMessages(raw?.messages || raw);
  } catch {
    return [];
  }
}

export async function writeWorkspaceChat(workspaceId, messages) {
  const dir = await resolveWorkspace(safeSegment(workspaceId));
  const file = path.join(dir, CHAT_FILE);
  const cleaned = sanitizeMessages(messages);
  await fs.writeFile(
    file,
    JSON.stringify({ updatedAt: new Date().toISOString(), messages: cleaned }, null, 2),
    { mode: 0o600 },
  );
  return cleaned;
}

export async function appendWorkspaceChat(workspaceId, message) {
  const current = await readWorkspaceChat(workspaceId);
  current.push(message);
  return writeWorkspaceChat(workspaceId, current);
}
