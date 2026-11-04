import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_KEY, resolveRequestId, runWithRequestId } from '../utils/request-context';

export const REQUEST_ID_HEADER = REQUEST_ID_KEY;

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
 * on the response, so the browser can quote it in a bug report. Everything the
 * request runs afterwards logs it automatically.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.get(REQUEST_ID_HEADER));
  req.id = id;
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader('X-Request-Id', id);
  runWithRequestId(id, next);
}
