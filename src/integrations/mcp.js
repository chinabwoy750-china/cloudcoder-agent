/**
 * MCP server configuration registry (groundwork).
 * Stores allowlisted MCP server definitions in platform settings when Postgres is available.
 * Does not execute untrusted MCP tools in-process yet.
 */
import { getPlatformSetting, setPlatformSetting } from '../db/platform-settings.js';
import { isPostgresConfigured } from '../storage/postgres.js';

const KEY = 'mcp_servers';

export async function listMcpServers() {
  if (!isPostgresConfigured()) {
    return { servers: [], note: 'DATABASE_URL required to persist MCP configs' };
  }
  const value = await getPlatformSetting(KEY, { servers: [] });
  return { servers: Array.isArray(value?.servers) ? value.servers : [] };
}

export async function saveMcpServers(servers) {
  if (!isPostgresConfigured()) {
    const err = new Error('DATABASE_URL required');
    err.status = 503;
    throw err;
  }
  const cleaned = (Array.isArray(servers) ? servers : []).slice(0, 20).map((s) => ({
    id: String(s.id || '').slice(0, 40),
    name: String(s.name || '').slice(0, 80),
    transport: ['stdio', 'sse', 'http'].includes(s.transport) ? s.transport : 'stdio',
    command: String(s.command || '').slice(0, 200),
    args: Array.isArray(s.args) ? s.args.map((a) => String(a).slice(0, 100)).slice(0, 20) : [],
    url: String(s.url || '').slice(0, 300),
    enabled: Boolean(s.enabled),
  })).filter((s) => s.id && s.name);
  await setPlatformSetting(KEY, { servers: cleaned });
  return { servers: cleaned };
}
