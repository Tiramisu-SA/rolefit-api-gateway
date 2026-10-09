import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { ClaimsVerifier } from '../src/auth/supabase';

/** Starts the app on a random local port. */
export async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: { field: string; message: string }[];
}

export const errorOf = async (res: Response) => ((await res.json()) as { error: ErrorBody }).error;

export const SEEKER = '11111111-1111-4111-8111-111111111111';
export const RECRUITER = '22222222-2222-4222-8222-222222222222';

/** Accepts "seeker-token" and "recruiter-token"; everything else is invalid. */
export const fakeVerifier: ClaimsVerifier = async (token) => {
  if (token === 'seeker-token') return { sub: SEEKER, app_metadata: { role: 'seeker' } };
  if (token === 'recruiter-token') return { sub: RECRUITER, app_metadata: { role: 'recruiter' } };
  return null;
};

/** A JWT-shaped string (bad signature) whose payload has the given `exp` (seconds). */
export function jwtWithExp(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: SEEKER, exp })}.signature`;
}
