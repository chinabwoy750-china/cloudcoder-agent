import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const target = `http://${config.opencode.hostname}:${config.opencode.port}`;

export const opencodeProxy = createProxyMiddleware({
  target,
  changeOrigin: true,
  pathRewrite: { '^/opencode': '' },
  proxyTimeout: 10 * 60 * 1000,
  timeout: 10 * 60 * 1000,
  on: {
    proxyReq(proxyReq) {
      const creds = Buffer.from(`${config.opencode.username}:${config.opencode.password}`).toString('base64');
      proxyReq.setHeader('Authorization', `Basic ${creds}`);
    },
    proxyRes(proxyRes, req) {
      if (proxyRes.statusCode >= 400) logger.debug(`Proxy ${req.method} ${req.originalUrl} → ${proxyRes.statusCode}`);
    },
    error(err, req, res) {
      logger.error(`Proxy error ${req.method} ${req.originalUrl}: ${err.message}`);
      if (res && !res.headersSent && typeof res.status === 'function') {
        res.status(502).json({ error: 'OpenCode backend unavailable' });
      }
    },
  },
});
