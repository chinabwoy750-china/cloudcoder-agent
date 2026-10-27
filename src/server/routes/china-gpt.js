import { Router } from 'express';
import { config } from '../../config/env.js';

const router = Router();
const baseURL = () => (process.env.CHINA_GPT_BASE_URL || config.customAI.baseURL || 'https://gpt-china.onrender.com').replace(/\/+$/, '');
const apiKey = () => process.env.CHINA_GPT_API_KEY || config.customAI.apiKey || '';

async function forward(req, res, endpoint, { binary = false } = {}) {
  if (!apiKey()) return res.status(503).json({ error: 'China-GPT is not configured. Set CHINA_GPT_API_KEY in Render environment variables.' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const upstream = await fetch(`${baseURL()}${endpoint}`, {
      method: req.method,
      headers: {
        'X-China-GPT-Key': apiKey(),
        'Content-Type': 'application/json',
        'Accept': binary ? '*/*' : 'application/json',
      },
      ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body || {}) }),
      signal: controller.signal,
    });
    const type = upstream.headers.get('content-type') || 'application/json';
    if (!upstream.ok) {
      const message = await upstream.text();
      return res.status(upstream.status).type('application/json').send(JSON.stringify({ error: `China-GPT request failed (${upstream.status})`, details: message.slice(0, 3000) }));
    }
    if (binary || !type.includes('json')) {
      res.setHeader('Content-Type', type);
      const disposition = upstream.headers.get('content-disposition');
      if (disposition) res.setHeader('Content-Disposition', disposition);
      const bytes = Buffer.from(await upstream.arrayBuffer());
      return res.status(upstream.status).send(bytes);
    }
    return res.status(upstream.status).json(await upstream.json());
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 502;
    return res.status(status).json({ error: status === 504 ? 'China-GPT request timed out' : 'Could not reach China-GPT', details: err.message });
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/models/all', (req, res) => forward(req, res, '/v1/models/all'));
router.post('/image-generation', (req, res) => forward(req, res, '/v1/image-generation'));
router.post('/video-generation', (req, res) => forward(req, res, '/v1/video-generation'));
router.post('/audio', (req, res) => forward(req, res, '/v1/audio', { binary: true }));
router.post('/web-fetch', (req, res) => forward(req, res, '/v1/web-fetch'));
export { router as chinaGptRouter };
