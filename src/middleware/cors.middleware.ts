import type { NextFunction, Request, Response } from 'express';

/**
 * Allows the web frontend (one configured origin) to call the gateway from the
 * browser. Answers preflight OPTIONS requests with 204; they are never forwarded.
 */
export function cors(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
