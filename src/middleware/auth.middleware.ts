import type { NextFunction, Request, Response } from 'express';
import type { AuthClaims, ClaimsVerifier } from '../auth/supabase';
import { logger } from '../utils/logger';
import { forbidden, invalidToken, missingToken, noCompany, tokenExpired } from '../utils/errors';

export interface GatewayUser {
  /** Supabase user id (JWT `sub`). */
  id: string;
  /** `app_metadata.role`: "seeker" or "recruiter". Only the Supabase server can write it. */
  role?: string;
  /** `app_metadata.company_id`, set once at recruiter signup, e.g. "co-acme-corp-7f3a9c". */
  companyId?: string;
  /** `app_metadata.company_name`, the company name typed at signup. */
  companyName?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The verified caller, set by `authenticate`. */
      user?: GatewayUser;
    }
  }
}

/**
 * Reads `exp` WITHOUT verifying the signature. Used only to choose between
 * TOKEN_EXPIRED and INVALID_TOKEN for a token the verifier already rejected.
 */
function looksExpired(token: string): boolean {
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' && exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

/**
 * Verifies the Supabase access token, then forwards the verified identity:
 * sets `X-User-Id`, `X-User-Role` and `X-Company-Id` from the token (client
 * values are always replaced or removed), and keeps `Authorization` so
 * services that verify tokens themselves still can.
 */
export function authenticate(verifyClaims: ClaimsVerifier) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.get('authorization') ?? '');
    if (!match) {
      next(missingToken());
      return;
    }
    const token = match[1];

    let claims: AuthClaims | null;
    try {
      claims = await verifyClaims(token);
    } catch (err) {
      logger.warn('Token verifier threw:', err instanceof Error ? err.message : String(err));
      claims = null;
    }
    if (!claims) {
      next(looksExpired(token) ? tokenExpired() : invalidToken());
      return;
    }

    const meta = claims.app_metadata ?? {};
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
    req.user = { id: claims.sub, role: text(meta.role) };
    const companyId = text(meta.company_id);
    const companyName = text(meta.company_name);
    if (companyId) req.user.companyId = companyId;
    if (companyName) req.user.companyName = companyName;
    // Downstream services trust these headers, so they only ever carry verified values.
    delete req.headers['x-user-role'];
    delete req.headers['x-company-id'];
    req.headers['x-user-id'] = claims.sub;
    if (req.user.role) req.headers['x-user-role'] = req.user.role;
    if (companyId) req.headers['x-company-id'] = companyId;
    next();
  };
}

/** Lets only recruiter accounts through (after `authenticate`). */
export function requireRecruiter(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'recruiter') {
    next(forbidden('This endpoint is for recruiter accounts only'));
    return;
  }
  next();
}

/** Lets only recruiters whose token carries a company through (after `requireRecruiter`). */
export function requireCompany(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.companyId) {
    next(noCompany());
    return;
  }
  next();
}

/** Lets only job seeker accounts through (after `authenticate`). */
export function requireSeeker(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'seeker') {
    next(forbidden('This endpoint is for job seeker accounts only'));
    return;
  }
  next();
}

/** Recruiters must carry a company; everyone else passes (the service checks ownership). */
export function requireCompanyIfRecruiter(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'recruiter') {
    requireCompany(req, res, next);
    return;
  }
  next();
}
