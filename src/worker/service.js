import http from 'node:http';
import { runIsolatedProcess, isolationMode } from './runner.js';
import { logger } from '../utils/logger.js';

const port = Number(process.env.PORT || process.env.WORKER_PORT || 10001);
const secret = process.env.WORKER_SHARED_SECRET || '';

function auth(req) {
  if (!secret) return process.env.NODE_ENV !== 'production';
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', role: 'worker', isolation: isolationMode() }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/exec') {
    if (!auth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    const { cwd, cmd, args = [], timeoutMs, network = false } = body;
    if (!cwd || !cmd || typeof cmd !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cwd and cmd required' }));
      return;
    }
    const root = process.env.WORKSPACE_ROOT || '/tmp/cloudcoder';
    if (!String(cwd).startsWith(root)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cwd outside WORKSPACE_ROOT' }));
      return;
    }
    try {
      const result = await runIsolatedProcess({ cwd, cmd, args, timeoutMs, network });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
  logger.info(`Worker service listening on ${port} isolation=${isolationMode()}`);
});
