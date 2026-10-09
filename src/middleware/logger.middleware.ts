import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/** Logs one line per request when the response is finished: method, path, status, duration. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
