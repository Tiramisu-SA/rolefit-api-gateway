import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

export interface AuthClaims {
  sub: string;
  exp?: number;
  app_metadata?: Record<string, unknown>;
}

/** Returns the verified claims, or null when the token is not valid. */
export type ClaimsVerifier = (token: string) => Promise<AuthClaims | null>;

/** Verify bearer tokens with Supabase and return only cryptographically verified claims. */
export function createClaimsVerifier(url: string, publishableKey: string): ClaimsVerifier {
  if (!url || !publishableKey) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for JWT verification');
  }

  const supabase = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return async (token) => {
    const { data, error } = await supabase.auth.getClaims(token);
    if (error) {
      logger.warn('Supabase token verification failed:', error.name, error.message);
      return null;
    }
    if (!data?.claims || typeof data.claims.sub !== 'string') return null;
    return data.claims as AuthClaims;
  };
}
