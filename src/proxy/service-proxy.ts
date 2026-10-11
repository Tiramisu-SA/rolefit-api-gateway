import type { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { serviceUnavailable } from '../utils/errors';
import { logger } from '../utils/logger';

const PROXY_TIMEOUT_MS = 10_000;

/**
 * Forwards everything under the mount path to the service's `upstreamPrefix`
 * (default /api), e.g. /api/candidates/profiles/me → <target>/api/profiles/me.
 * The Application Service keeps its own prefix: /api/applications. Method, query,
 * headers and the raw body stream go through as-is, and the service's status
 * and body come back unchanged (a 404 stays a 404).
 */
export function createServiceProxy(target: string, service: string, upstreamPrefix = '/api') {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    proxyTimeout: PROXY_TIMEOUT_MS,
    // The path seen here is relative to the mount, e.g. /profiles/me under /api/candidates.
    // A bare "/" (with or without a query) maps to the prefix itself: /?jobId=1 → /api/applications?jobId=1.
    pathRewrite: (path) => (path === '/' || path.startsWith('/?') ? upstreamPrefix + path.slice(1) : upstreamPrefix + path),
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
