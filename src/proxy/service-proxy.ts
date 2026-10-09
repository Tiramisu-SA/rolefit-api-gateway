import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { serviceUnavailable } from '../utils/errors';
import { logger } from '../utils/logger';

const PROXY_TIMEOUT_MS = 10_000;

/**
 * Forwards everything under the mount path to the service's /api, e.g.
 * /api/candidates/profiles/me → <target>/api/profiles/me. Method, query,
 * headers and the raw body stream go through as-is, and the service's status
 * and body come back unchanged (a 404 stays a 404).
 */
export function createServiceProxy(target: string, service: string) {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    proxyTimeout: PROXY_TIMEOUT_MS,
    // Under app.use('/api/candidates', …) the path seen here is the rest, e.g. /profiles/me.
    pathRewrite: (path) => `/api${path}`,
    on: {
      proxyRes: (proxyRes) => {
        // The gateway owns CORS; a second Access-Control-* set would make the browser reject the response.
        for (const name of Object.keys(proxyRes.headers)) {
          if (name.startsWith('access-control-')) delete proxyRes.headers[name];
        }
      },
      error: (err, _req, res) => {
        logger.error(`${service} service unreachable:`, err.message);
        if (!('writeHead' in res)) {
          res.destroy();
          return;
        }
        if (res.headersSent) {
          res.end();
          return;
        }
        const e = serviceUnavailable(service);
        res.writeHead(e.httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: e.code, message: e.message } }));
      },
    },
  });
}
