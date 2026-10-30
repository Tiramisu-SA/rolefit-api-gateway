import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

// Letters, digits, ".", "_", "-" only, so a client cannot inject log lines or odd headers.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The request id, set by `requestId`. Same value as the X-Request-Id header. */
      id: string;
    }
  }
}

/**
 * Keeps a safe incoming X-Request-Id or creates a new UUID. The id is written
 * back to the request headers, so proxied services receive it, and returned
 * on the response, so the browser can quote it in a bug report.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
