const silent = process.env.NODE_ENV === 'test';

/**
 * Minimal logger wrapper, like the services'. Silent under NODE_ENV=test so
 * test output stays readable.
 */
export const logger = {
  info: (...args: unknown[]) => !silent && console.log('[api-gateway]', ...args),
  warn: (...args: unknown[]) => !silent && console.warn('[api-gateway]', ...args),
  error: (...args: unknown[]) => !silent && console.error('[api-gateway]', ...args),
};
