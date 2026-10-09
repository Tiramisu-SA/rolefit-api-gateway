# RoleFit API Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Express API Gateway that becomes the frontend's only backend entry point (Supabase JWT verification, REST proxying to Candidate Profile + Job Discovery, REST→gRPC translation for Job Posting), and migrate the frontend to call only the gateway.

**Architecture:** `rolefit-api-gateway` is a small TypeScript Express 5 app. `/api/candidates/*` and `/api/discovery/*` are streamed to the two REST services with `http-proxy-middleware`; `/api/jobs/*` is a thin route table that calls the gRPC-only Job Posting Service and returns the proto messages as JSON. Every `/api/*` request is authenticated with Supabase `getClaims()`, and the verified user id is forwarded as `X-User-Id`. The frontend gets one `gatewayRequest()` helper that adds the Supabase access token.

**Tech Stack:** Node ≥ 20, TypeScript, Express 5, http-proxy-middleware 3, @supabase/supabase-js 2, @grpc/grpc-js + @grpc/proto-loader, dotenv, tsx, node:test. Frontend: Next.js 16, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-api-gateway-design.md`

## Global Constraints

- Do NOT modify `rolefit-candidate-profile-service`, `rolefit-job-discovery-service` or `rolefit-job-posting-service`.
- No business logic in the gateway: Job Posting bodies/responses pass through unchanged; validation stays in the services.
- TypeScript, CommonJS, Express 5, `tsx`, `node:test` — same as the services.
- Error body shape everywhere: `{ "error": { "code": string, "message": string, "details"?: FieldError[] } }`.
- Health: `GET /health` → `{ "status": "ok", "service": "rolefit-api-gateway" }`, no auth.
- Env names (gateway): `PORT=8080`, `FRONTEND_URL=http://localhost:3000`, `CANDIDATE_PROFILE_SERVICE_URL=http://localhost:3001`, `JOB_DISCOVERY_SERVICE_URL=http://localhost:3002`, `JOB_POSTING_GRPC_URL=localhost:50052`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DEV_RECRUITER_COMPANY_ID=co-brightline`.
- Env name (frontend): `NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080`.
- CORS origin is `FRONTEND_URL`, never `*`. Allowed headers: `Authorization, Content-Type, X-File-Name`.
- proto-loader options: `{ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }`.
- Frontend: change networking code only — no page, component, styling or behaviour changes.
- Never commit `.env` files or real secrets.
- In zsh, quote globs in commands (e.g. `grep -rn --include='*.ts'`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

Gateway (`/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`):

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.env.example`, `README.md` | project setup and docs |
| `src/config/env.ts` | `loadConfig(source?)` → validated `GatewayConfig` |
| `src/utils/logger.ts` | `logger.info/warn/error` (silent when `NODE_ENV=test`) |
| `src/utils/errors.ts` | `AppError`, `FieldError`, error factories |
| `src/middleware/error.middleware.ts` | `notFoundHandler`, `errorHandler` |
| `src/auth/supabase.ts` | `ClaimsVerifier`, `createClaimsVerifier()` |
| `src/middleware/auth.middleware.ts` | `authenticate(verifier)`, `requireRecruiter` |
| `src/grpc/grpc-errors.ts` | `grpcErrorToAppError()` |
| `src/grpc/job-posting.client.ts` | `JobPostingCaller`, `createJobPostingCaller(url)` |
| `src/routes/job.routes.ts` | `createJobRoutes(caller, companyId)` |
| `src/proxy/service-proxy.ts` | `createServiceProxy(target, service)` |
| `src/middleware/cors.middleware.ts` | `cors(origin)` |
| `src/middleware/logger.middleware.ts` | `requestLogger` |
| `src/app.ts` | `createApp(deps)` |
| `src/server.ts` | real wiring + listen |
| `proto/job-posting.proto` | copy of the Job Posting contract |
| `tests/helpers.ts`, `tests/*.test.ts` | tests |

Frontend (`/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`):

| File | Change |
|---|---|
| `src/lib/api/gateway.ts` (+ test) | new: the one HTTP client |
| `src/lib/api/candidate-profile.ts` (+ test) | use `gatewayRequest` |
| `src/lib/api/job-discovery.ts` (+ test) | use `gatewayRequest` |
| `src/lib/api/job-mapper.ts` (+ test) | moved from `src/lib/grpc/`, gRPC error code removed |
| `src/lib/api/job-posting.ts` (+ new test) | gateway calls instead of Server Actions |
| `src/lib/api/job-posting-actions.ts`, `src/lib/grpc/job-posting-client.ts`, `src/lib/identity.ts`, `src/lib/identity.server.ts`, `proto/` | delete |
| `package.json`, `next.config.ts`, `.env.example`, `README.md`, `scripts/e2e-smoke.ts`, `src/lib/types.ts` (one comment) | update |

---

### Task 1: Gateway scaffold — config, errors, logger, error middleware

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `src/config/env.ts`, `src/utils/logger.ts`, `src/utils/errors.ts`, `src/middleware/error.middleware.ts`, `tests/helpers.ts`
- Test: `tests/env.test.ts`, `tests/error.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(source?: NodeJS.ProcessEnv): GatewayConfig` with fields `nodeEnv, port, frontendUrl, candidateProfileUrl, jobDiscoveryUrl, jobPostingGrpcUrl, supabaseUrl, supabasePublishableKey, recruiterCompanyId`
  - `class AppError(message: string, httpStatus = 500, code = 'INTERNAL_ERROR', details?: FieldError[])`
  - `interface FieldError { field: string; message: string }`
  - factories `missingToken()`, `invalidToken()`, `tokenExpired()`, `forbidden(message?)`, `serviceUnavailable(service: string)`
  - `notFoundHandler(req, res)`, `errorHandler(err, req, res, next)`
  - `logger.info/warn/error(...args)`
  - `tests/helpers.ts`: `listen(app): Promise<{ base: string; close(): Promise<void> }>`, `errorOf(res)`

All commands in Tasks 1–6 run in `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "rolefit-api-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "description": "RoleFit API Gateway - the single public backend entry point for the web frontend.",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "NODE_ENV=test tsx --test tests/*.test.ts"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express http-proxy-middleware @supabase/supabase-js @grpc/grpc-js @grpc/proto-loader dotenv
npm install -D typescript tsx @types/express @types/node
```
Expected: `package.json` gains `dependencies` and `devDependencies`; `package-lock.json` is created. Check `express` is `^5.x` and `http-proxy-middleware` is `^3.x`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Create `.env.example`**

```env
# Copy this file to .env and fill in your values. Never commit .env.
NODE_ENV=development

# Port the gateway listens on. The frontend calls only this.
PORT=8080

# Web frontend origin allowed by CORS (never "*": requests carry Authorization headers).
FRONTEND_URL=http://localhost:3000

# Downstream services
CANDIDATE_PROFILE_SERVICE_URL=http://localhost:3001
JOB_DISCOVERY_SERVICE_URL=http://localhost:3002
# Job Posting has no REST API: the gateway calls it over gRPC (host:port, no scheme).
JOB_POSTING_GRPC_URL=localhost:50052

# Supabase Auth token verification (project URL + publishable key; never the service role key).
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_<key>

# Mock recruiter company sent to Job Posting as x-company-id (the JWT has no company yet).
DEV_RECRUITER_COMPANY_ID=co-brightline
```

- [ ] **Step 5: Create `src/utils/logger.ts`**

```ts
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
```

- [ ] **Step 6: Create `src/utils/errors.ts`**

```ts
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Base error type. The error middleware turns it into
 * `{ error: { code, message, details? } }`, the same envelope the services use,
 * so the frontend parses gateway and service errors the same way.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 500,
    public readonly code: string = 'INTERNAL_ERROR',
    public readonly details?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export const missingToken = () => new AppError('Missing Authorization: Bearer <token> header', 401, 'MISSING_TOKEN');
export const invalidToken = () => new AppError('Invalid access token', 401, 'INVALID_TOKEN');
export const tokenExpired = () => new AppError('Access token has expired. Please sign in again.', 401, 'TOKEN_EXPIRED');
export const forbidden = (message = 'You do not have access to this resource') => new AppError(message, 403, 'FORBIDDEN');

/** A downstream service is down or timed out. */
export const serviceUnavailable = (service: string) =>
  new AppError(`The ${service} service is unavailable. Please try again.`, 503, 'SERVICE_UNAVAILABLE');
```

- [ ] **Step 7: Create `src/middleware/error.middleware.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

/** 404 for unknown gateway routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `${req.method} ${req.originalUrl.split('?')[0]} not found` } });
}

/** Errors raised by Express body parsers carry a `type`. */
function fromBodyParser(err: unknown): AppError | null {
  const type = (err as { type?: unknown })?.type;
  if (type === 'entity.parse.failed') return new AppError('The request body is not valid JSON', 400, 'MALFORMED_JSON');
  if (type === 'entity.too.large') return new AppError('The request body is too large', 413, 'PAYLOAD_TOO_LARGE');
  return null;
}

/**
 * Converts thrown errors into JSON responses. Unknown errors are logged and
 * answered with a generic 500 so internal details never leak.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const appError = err instanceof AppError ? err : fromBodyParser(err);
  if (appError) {
    const details = appError.details ? { details: appError.details } : {};
    res.status(appError.httpStatus).json({ error: { code: appError.code, message: appError.message, ...details } });
    return;
  }

  logger.error('Unhandled error', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
```

- [ ] **Step 8: Create `tests/helpers.ts`**

```ts
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

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
```

- [ ] **Step 9: Write the failing tests**

`tests/env.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env';

const valid = {
  PORT: '8080',
  FRONTEND_URL: 'http://localhost:3000',
  CANDIDATE_PROFILE_SERVICE_URL: 'http://localhost:3001/',
  JOB_DISCOVERY_SERVICE_URL: 'http://localhost:3002',
  JOB_POSTING_GRPC_URL: 'localhost:50052',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
};

test('loadConfig reads every variable and strips trailing slashes', () => {
  const config = loadConfig({ ...valid, DEV_RECRUITER_COMPANY_ID: 'co-x' });
  assert.equal(config.port, 8080);
  assert.equal(config.candidateProfileUrl, 'http://localhost:3001');
  assert.equal(config.jobDiscoveryUrl, 'http://localhost:3002');
  assert.equal(config.jobPostingGrpcUrl, 'localhost:50052');
  assert.equal(config.recruiterCompanyId, 'co-x');
});

test('loadConfig applies defaults for optional variables', () => {
  const { PORT, FRONTEND_URL, ...required } = valid;
  const config = loadConfig(required);
  assert.equal(config.port, 8080);
  assert.equal(config.frontendUrl, 'http://localhost:3000');
  assert.equal(config.recruiterCompanyId, 'co-brightline');
  assert.equal(config.nodeEnv, 'development');
});

test('loadConfig reports every missing or invalid variable at once', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc', CANDIDATE_PROFILE_SERVICE_URL: 'localhost:3001' }),
    (err: Error) =>
      [
        'PORT must be',
        'CANDIDATE_PROFILE_SERVICE_URL must start with http',
        'JOB_DISCOVERY_SERVICE_URL is required',
        'JOB_POSTING_GRPC_URL is required',
        'SUPABASE_URL is required',
        'SUPABASE_PUBLISHABLE_KEY is required',
      ].every((part) => err.message.includes(part)),
  );
});
```

`tests/error.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler, notFoundHandler } from '../src/middleware/error.middleware';
import { AppError } from '../src/utils/errors';
import { errorOf, listen } from './helpers';

function app() {
  const a = express();
  a.get('/app-error', () => {
    throw new AppError('Some fields are invalid', 400, 'VALIDATION_ERROR', [{ field: 'title', message: 'Is required' }]);
  });
  a.get('/crash', () => {
    throw new Error('secret stack detail');
  });
  a.post('/json', express.json(), (_req, res) => {
    res.json({ ok: true });
  });
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

test('AppError becomes its status and envelope, with details', async () => {
  const { base, close } = await listen(app());
  try {
    const res = await fetch(`${base}/app-error`);
    assert.equal(res.status, 400);
    assert.deepEqual(await errorOf(res), {
      code: 'VALIDATION_ERROR',
      message: 'Some fields are invalid',
      details: [{ field: 'title', message: 'Is required' }],
    });
  } finally {
    await close();
  }
});

test('unknown errors become a generic 500', async () => {
  const { base, close } = await listen(app());
  try {
    const res = await fetch(`${base}/crash`);
    assert.equal(res.status, 500);
    assert.deepEqual(await errorOf(res), { code: 'INTERNAL_ERROR', message: 'Internal server error' });
  } finally {
    await close();
  }
});

test('malformed JSON is 400 MALFORMED_JSON; unknown route is 404 ROUTE_NOT_FOUND', async () => {
  const { base, close } = await listen(app());
  try {
    const bad = await fetch(`${base}/json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await errorOf(bad)).code, 'MALFORMED_JSON');

    const missing = await fetch(`${base}/nowhere?x=1`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await errorOf(missing), { code: 'ROUTE_NOT_FOUND', message: 'GET /nowhere not found' });
  } finally {
    await close();
  }
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config/env'`.

- [ ] **Step 11: Create `src/config/env.ts`**

```ts
import dotenv from 'dotenv';

// .env.local wins over .env (dotenv never overrides a variable that is already set).
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export interface GatewayConfig {
  nodeEnv: string;
  /** Port the gateway listens on. */
  port: number;
  /** Web frontend origin allowed by CORS. */
  frontendUrl: string;
  /** Candidate Profile Service REST base URL, no trailing slash. */
  candidateProfileUrl: string;
  /** Job Discovery Service REST base URL, no trailing slash. */
  jobDiscoveryUrl: string;
  /** Job Posting Service gRPC address (host:port). */
  jobPostingGrpcUrl: string;
  /** Supabase project URL used to verify access tokens. */
  supabaseUrl: string;
  /** Supabase publishable key; never a service role key. */
  supabasePublishableKey: string;
  /** Mock company sent to Job Posting as x-company-id for recruiter calls. */
  recruiterCompanyId: string;
}

/** Reads and validates the environment. Reports every problem at once. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const errors: string[] = [];
  const read = (name: string) => source[name]?.trim() ?? '';

  const required = (name: string) => {
    const value = read(name);
    if (value === '') errors.push(`${name} is required`);
    return value;
  };

  const httpUrl = (name: string) => {
    const value = required(name);
    if (value !== '' && !/^https?:\/\//.test(value)) {
      errors.push(`${name} must start with http:// or https:// (got "${value}")`);
    }
    return value.replace(/\/+$/, '');
  };

  const rawPort = read('PORT');
  const port = rawPort === '' ? 8080 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be a whole number between 1 and 65535 (got "${rawPort}")`);
  }

  const config: GatewayConfig = {
    nodeEnv: read('NODE_ENV') || 'development',
    port,
    frontendUrl: read('FRONTEND_URL') || 'http://localhost:3000',
    candidateProfileUrl: httpUrl('CANDIDATE_PROFILE_SERVICE_URL'),
    jobDiscoveryUrl: httpUrl('JOB_DISCOVERY_SERVICE_URL'),
    jobPostingGrpcUrl: required('JOB_POSTING_GRPC_URL'),
    supabaseUrl: httpUrl('SUPABASE_URL'),
    supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    recruiterCompanyId: read('DEV_RECRUITER_COMPANY_ID') || 'co-brightline',
  };

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests in `env.test.ts` and `error.test.ts` PASS; typecheck prints nothing.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example src tests
git commit -m "feat: scaffold gateway config, errors and error middleware

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Supabase JWT authentication middleware

**Files:**
- Create: `src/auth/supabase.ts`, `src/middleware/auth.middleware.ts`
- Modify: `tests/helpers.ts` (append fakes)
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `missingToken, invalidToken, tokenExpired, forbidden` (Task 1), `errorHandler` (Task 1)
- Produces:
  - `interface AuthClaims { sub: string; exp?: number; app_metadata?: Record<string, unknown> }`
  - `type ClaimsVerifier = (token: string) => Promise<AuthClaims | null>`
  - `createClaimsVerifier(url: string, publishableKey: string): ClaimsVerifier`
  - `interface GatewayUser { id: string; role?: string }`, global `Express.Request.user?: GatewayUser`
  - `authenticate(verifyClaims: ClaimsVerifier): RequestHandler` — sets `req.user`, overwrites `x-user-id` with `sub`, deletes `x-company-id`, keeps `authorization`
  - `requireRecruiter: RequestHandler` — 403 unless `req.user.role === 'recruiter'`
  - `tests/helpers.ts`: `SEEKER`, `RECRUITER`, `fakeVerifier`, `jwtWithExp(exp)`

- [ ] **Step 1: Append fakes to `tests/helpers.ts`**

Add to the top imports: `import type { ClaimsVerifier } from '../src/auth/supabase';` and append at the end:

```ts
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
```

- [ ] **Step 2: Write the failing test `tests/auth.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authenticate, requireRecruiter } from '../src/middleware/auth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import { errorOf, fakeVerifier, jwtWithExp, listen, SEEKER } from './helpers';

function app() {
  const a = express();
  a.use(authenticate(fakeVerifier));
  a.get('/echo', (req, res) => {
    res.json({
      user: req.user,
      xUserId: req.get('x-user-id') ?? null,
      xCompanyId: req.get('x-company-id') ?? null,
      authorization: req.get('authorization') ?? null,
    });
  });
  a.get('/recruiter-only', requireRecruiter, (_req, res) => {
    res.json({ ok: true });
  });
  a.use(errorHandler);
  return a;
}

async function call(path: string, headers: Record<string, string> = {}) {
  const { base, close } = await listen(app());
  try {
    const res = await fetch(base + path, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await close();
  }
}

test('no Authorization header is 401 MISSING_TOKEN', async () => {
  const { status, body } = await call('/echo');
  assert.equal(status, 401);
  assert.equal((body.error as { code: string }).code, 'MISSING_TOKEN');
});

test('a non-Bearer Authorization header is 401 MISSING_TOKEN', async () => {
  const { status, body } = await call('/echo', { Authorization: 'Basic abc' });
  assert.equal(status, 401);
  assert.equal((body.error as { code: string }).code, 'MISSING_TOKEN');
});

test('a token the verifier rejects is 401 INVALID_TOKEN', async () => {
  const { status, body } = await call('/echo', { Authorization: 'Bearer forged' });
  assert.equal(status, 401);
  assert.equal((body.error as { code: string }).code, 'INVALID_TOKEN');
});

test('a rejected token whose exp is in the past is 401 TOKEN_EXPIRED', async () => {
  const { status, body } = await call('/echo', { Authorization: `Bearer ${jwtWithExp(1)}` });
  assert.equal(status, 401);
  assert.equal((body.error as { code: string }).code, 'TOKEN_EXPIRED');
});

test('a rejected token whose exp is in the future is still INVALID_TOKEN', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const { body } = await call('/echo', { Authorization: `Bearer ${jwtWithExp(future)}` });
  assert.equal((body.error as { code: string }).code, 'INVALID_TOKEN');
});

test('a verifier that throws is treated as an invalid token', async () => {
  const a = express();
  a.use(authenticate(async () => {
    throw new Error('network down');
  }));
  a.get('/echo', (_req, res) => {
    res.json({ ok: true });
  });
  a.use(errorHandler);
  const { base, close } = await listen(a);
  try {
    const res = await fetch(`${base}/echo`, { headers: { Authorization: 'Bearer seeker-token' } });
    assert.equal(res.status, 401);
    assert.equal((await errorOf(res)).code, 'INVALID_TOKEN');
  } finally {
    await close();
  }
});

test('a valid token sets req.user, overwrites spoofed identity headers and keeps Authorization', async () => {
  const { status, body } = await call('/echo', {
    Authorization: 'Bearer seeker-token',
    'X-User-Id': '99999999-9999-4999-8999-999999999999',
    'X-Company-Id': 'co-spoofed',
  });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    user: { id: SEEKER, role: 'seeker' },
    xUserId: SEEKER,
    xCompanyId: null,
    authorization: 'Bearer seeker-token',
  });
});

test('requireRecruiter allows recruiters and refuses seekers with 403 FORBIDDEN', async () => {
  const ok = await call('/recruiter-only', { Authorization: 'Bearer recruiter-token' });
  assert.equal(ok.status, 200);

  const refused = await call('/recruiter-only', { Authorization: 'Bearer seeker-token' });
  assert.equal(refused.status, 403);
  assert.equal((refused.body.error as { code: string }).code, 'FORBIDDEN');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/middleware/auth.middleware'`.

- [ ] **Step 4: Create `src/auth/supabase.ts`**

```ts
import { createClient } from '@supabase/supabase-js';

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
    if (error || !data?.claims || typeof data.claims.sub !== 'string') return null;
    return data.claims as AuthClaims;
  };
}
```

- [ ] **Step 5: Create `src/middleware/auth.middleware.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
import type { AuthClaims, ClaimsVerifier } from '../auth/supabase';
import { forbidden, invalidToken, missingToken, tokenExpired } from '../utils/errors';

export interface GatewayUser {
  /** Supabase user id (JWT `sub`). */
  id: string;
  /** `app_metadata.role`: "seeker" or "recruiter". Only the Supabase server can write it. */
  role?: string;
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
 * `X-User-Id` is always the token's subject (a client-sent value is replaced),
 * `X-Company-Id` from the client is dropped, and `Authorization` is kept so
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
    } catch {
      claims = null;
    }
    if (!claims) {
      next(looksExpired(token) ? tokenExpired() : invalidToken());
      return;
    }

    const role = claims.app_metadata?.role;
    req.user = { id: claims.sub, role: typeof role === 'string' ? role : undefined };
    delete req.headers['x-company-id'];
    req.headers['x-user-id'] = claims.sub;
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all `auth.test.ts` tests PASS, earlier tests still PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/auth src/middleware/auth.middleware.ts tests
git commit -m "feat: verify Supabase JWTs and forward the verified user id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Job Posting gRPC client and error mapping

**Files:**
- Create: `proto/job-posting.proto` (copy), `src/grpc/grpc-errors.ts`, `src/grpc/job-posting.client.ts`
- Test: `tests/grpc-errors.test.ts`, `tests/job-posting.client.test.ts`

**Interfaces:**
- Consumes: `AppError`, `FieldError`, `serviceUnavailable` (Task 1)
- Produces:
  - `interface GrpcLikeError { code?: number; details?: string; metadata?: { get(key: string): unknown[] } }`
  - `grpcErrorToAppError(err: GrpcLikeError): AppError`
  - `type JobMessage = Record<string, unknown>`
  - `interface RecruiterCaller { userId: string; companyId: string }`
  - `type JobPostingCaller = <T = JobMessage>(method: string, request: object, caller?: RecruiterCaller) => Promise<T>` — rejects only with `AppError`
  - `createJobPostingCaller(url: string, deadlineMs = 5000): JobPostingCaller`

- [ ] **Step 1: Copy the proto contract**

```bash
mkdir -p proto && cp ../rolefit-job-posting-service/proto/job-posting.proto proto/job-posting.proto
```
Expected: `grep -c "rpc " proto/job-posting.proto` prints `11`.

- [ ] **Step 2: Write the failing test `tests/grpc-errors.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '@grpc/grpc-js';
import { grpcErrorToAppError } from '../src/grpc/grpc-errors';

function grpcError(code: number, details: string, metadata: Record<string, string> = {}) {
  return { code, details, metadata: { get: (key: string) => (key in metadata ? [metadata[key]] : []) } };
}

test('maps client-error statuses to HTTP and keeps the service message', () => {
  const cases: [number, number, string][] = [
    [status.NOT_FOUND, 404, 'NOT_FOUND'],
    [status.FAILED_PRECONDITION, 409, 'INVALID_STATE'],
    [status.PERMISSION_DENIED, 403, 'FORBIDDEN'],
    [status.UNAUTHENTICATED, 401, 'UNAUTHENTICATED'],
  ];
  for (const [code, httpStatus, appCode] of cases) {
    const err = grpcErrorToAppError(grpcError(code, 'from service'));
    assert.equal(err.httpStatus, httpStatus);
    assert.equal(err.code, appCode);
    assert.equal(err.message, 'from service');
  }
});

test('INVALID_ARGUMENT reads field errors from the x-validation-errors trailer', () => {
  const err = grpcErrorToAppError(
    grpcError(status.INVALID_ARGUMENT, 'title: Is required', {
      'x-validation-errors': JSON.stringify([{ field: 'title', message: 'Is required' }]),
    }),
  );
  assert.equal(err.httpStatus, 400);
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.deepEqual(err.details, [{ field: 'title', message: 'Is required' }]);
});

test('unreadable x-validation-errors is ignored', () => {
  const err = grpcErrorToAppError(grpcError(status.INVALID_ARGUMENT, 'bad', { 'x-validation-errors': '{not json' }));
  assert.equal(err.details, undefined);
});

test('UNAVAILABLE and DEADLINE_EXCEEDED become 503 SERVICE_UNAVAILABLE', () => {
  for (const code of [status.UNAVAILABLE, status.DEADLINE_EXCEEDED]) {
    const err = grpcErrorToAppError(grpcError(code, 'connect ECONNREFUSED 127.0.0.1:50052'));
    assert.equal(err.httpStatus, 503);
    assert.equal(err.code, 'SERVICE_UNAVAILABLE');
    assert.equal(err.message, 'The job posting service is unavailable. Please try again.');
  }
});

test('other statuses become a generic 500 that hides details', () => {
  const err = grpcErrorToAppError(grpcError(status.INTERNAL, 'stack trace...'));
  assert.equal(err.httpStatus, 500);
  assert.equal(err.code, 'INTERNAL_ERROR');
  assert.equal(err.message, 'Something went wrong with the job service. Please try again.');
});
```

- [ ] **Step 3: Write the failing test `tests/job-posting.client.test.ts`**

This starts a real in-process gRPC server from the same proto, so it checks the loader options, metadata and trailers end to end.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createJobPostingCaller } from '../src/grpc/job-posting.client';
import { AppError } from '../src/utils/errors';

const PROTO = path.join(__dirname, '..', 'proto', 'job-posting.proto');

async function startFakeJobPosting(impl: grpc.UntypedServiceImplementation) {
  const definition = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    rolefit: { jobposting: { v1: { JobPostingService: grpc.ServiceClientConstructor } } };
  };
  const server = new grpc.Server();
  server.addService(loaded.rolefit.jobposting.v1.JobPostingService.service, impl);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return { url: `127.0.0.1:${port}`, stop: () => server.forceShutdown() };
}

const echoGetJob: grpc.UntypedServiceImplementation = {
  GetJob: (call: grpc.ServerUnaryCall<{ job_id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    callback(null, {
      job: {
        id: call.request.job_id,
        recruiter_id: String(call.metadata.get('x-user-id')[0] ?? ''),
        company_id: String(call.metadata.get('x-company-id')[0] ?? ''),
      },
    });
  },
};

test('sends the request and recruiter metadata, returns the proto message as a plain object', async () => {
  const fake = await startFakeJobPosting(echoGetJob);
  try {
    const call = createJobPostingCaller(fake.url);
    const res = await call<{ job: Record<string, unknown> }>('GetJob', { job_id: 'job_1' }, { userId: 'u1', companyId: 'co-x' });
    assert.equal(res.job.id, 'job_1');
    assert.equal(res.job.recruiter_id, 'u1');
    assert.equal(res.job.company_id, 'co-x');
    // defaults: true + enums: String → unset enum comes back as its name
    assert.equal(res.job.status, 'JOB_STATUS_UNSPECIFIED');
  } finally {
    fake.stop();
  }
});

test('sends no identity metadata when no caller is given', async () => {
  const fake = await startFakeJobPosting(echoGetJob);
  try {
    const res = await createJobPostingCaller(fake.url)<{ job: Record<string, unknown> }>('GetJob', { job_id: 'job_1' });
    assert.equal(res.job.recruiter_id, '');
    assert.equal(res.job.company_id, '');
  } finally {
    fake.stop();
  }
});

test('a gRPC error with a validation trailer becomes a 400 AppError with details', async () => {
  const fake = await startFakeJobPosting({
    CreateJob: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
      const metadata = new grpc.Metadata();
      metadata.set('x-validation-errors', JSON.stringify([{ field: 'title', message: 'Is required' }]));
      callback({ code: grpc.status.INVALID_ARGUMENT, details: 'title: Is required', metadata });
    },
  });
  try {
    await assert.rejects(createJobPostingCaller(fake.url)('CreateJob', { job: {} }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.httpStatus, 400);
      assert.deepEqual(err.details, [{ field: 'title', message: 'Is required' }]);
      return true;
    });
  } finally {
    fake.stop();
  }
});

test('an unreachable service rejects with 503 SERVICE_UNAVAILABLE', async () => {
  const call = createJobPostingCaller('127.0.0.1:1', 2000);
  await assert.rejects(call('GetJob', { job_id: 'job_1' }), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.httpStatus, 503);
    assert.equal(err.code, 'SERVICE_UNAVAILABLE');
    return true;
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/grpc/grpc-errors'`.

- [ ] **Step 5: Create `src/grpc/grpc-errors.ts`**

```ts
import { status } from '@grpc/grpc-js';
import { AppError, serviceUnavailable, type FieldError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface GrpcLikeError {
  code?: number;
  details?: string;
  metadata?: { get(key: string): unknown[] };
}

/** The Job Posting Service puts field errors as JSON in the `x-validation-errors` trailer. */
function readFieldErrors(err: GrpcLikeError): FieldError[] | undefined {
  const [raw] = err.metadata?.get('x-validation-errors') ?? [];
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldError[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A gRPC error from the Job Posting Service → an HTTP AppError. Client errors
 * keep the service's message; unexpected errors are logged and hidden.
 */
export function grpcErrorToAppError(err: GrpcLikeError): AppError {
  const details = err.details || 'The job service returned an error';
  switch (err.code) {
    case status.INVALID_ARGUMENT:
      return new AppError(details, 400, 'VALIDATION_ERROR', readFieldErrors(err));
    case status.NOT_FOUND:
      return new AppError(details, 404, 'NOT_FOUND');
    case status.FAILED_PRECONDITION:
      return new AppError(details, 409, 'INVALID_STATE');
    case status.PERMISSION_DENIED:
      return new AppError(details, 403, 'FORBIDDEN');
    case status.UNAUTHENTICATED:
      return new AppError(details, 401, 'UNAUTHENTICATED');
    case status.UNAVAILABLE:
    case status.DEADLINE_EXCEEDED:
      return serviceUnavailable('job posting');
    default:
      logger.error('Unexpected Job Posting gRPC error', err.code, err.details);
      return new AppError('Something went wrong with the job service. Please try again.', 500, 'INTERNAL_ERROR');
  }
}
```

- [ ] **Step 6: Create `src/grpc/job-posting.client.ts`**

```ts
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { grpcErrorToAppError } from './grpc-errors';

const DEADLINE_MS = 5000;
const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'job-posting.proto');

/** A proto message as a plain object (snake_case keys, enum names as strings). */
export type JobMessage = Record<string, unknown>;

/** Recruiter identity, sent as the `x-user-id` / `x-company-id` metadata. */
export interface RecruiterCaller {
  userId: string;
  companyId: string;
}

/** Calls one unary Job Posting RPC. Rejects only with an AppError, never a raw gRPC error. */
export type JobPostingCaller = <T = JobMessage>(method: string, request: object, caller?: RecruiterCaller) => Promise<T>;

type UnaryMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, response: unknown) => void,
) => void;

/** One channel to the Job Posting Service for the whole process. */
export function createJobPostingCaller(url: string, deadlineMs = DEADLINE_MS): JobPostingCaller {
  const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    rolefit: { jobposting: { v1: { JobPostingService: grpc.ServiceClientConstructor } } };
  };
  const Client = loaded.rolefit.jobposting.v1.JobPostingService;
  const client = new Client(url, grpc.credentials.createInsecure()) as grpc.Client & Record<string, UnaryMethod>;

  return <T>(method: string, request: object, caller?: RecruiterCaller) =>
    new Promise<T>((resolve, reject) => {
      const metadata = new grpc.Metadata();
      if (caller) {
        metadata.set('x-user-id', caller.userId);
        metadata.set('x-company-id', caller.companyId);
      }
      client[method](request, metadata, { deadline: Date.now() + deadlineMs }, (err, response) => {
        if (err) reject(grpcErrorToAppError(err));
        else resolve(response as T);
      });
    });
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (the unreachable test takes up to ~2 s), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add proto src/grpc tests
git commit -m "feat: add Job Posting gRPC client with HTTP error mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Job routes (REST → gRPC)

**Files:**
- Create: `src/routes/job.routes.ts`
- Test: `tests/job.routes.test.ts`

**Interfaces:**
- Consumes: `JobPostingCaller`, `JobMessage`, `RecruiterCaller` (Task 3), `requireRecruiter`, `Express.Request.user` (Task 2), `errorHandler` (Task 1), `AppError` (Task 1)
- Produces: `createJobRoutes(jobPosting: JobPostingCaller, recruiterCompanyId: string): Router` — mounted at `/api/jobs` in Task 5

- [ ] **Step 1: Write the failing test `tests/job.routes.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { JobMessage, JobPostingCaller, RecruiterCaller } from '../src/grpc/job-posting.client';
import { errorHandler } from '../src/middleware/error.middleware';
import { createJobRoutes } from '../src/routes/job.routes';
import { AppError } from '../src/utils/errors';
import { errorOf, listen, RECRUITER, SEEKER } from './helpers';

interface Call {
  method: string;
  request: Record<string, unknown>;
  caller?: RecruiterCaller;
}

function recording(response: JobMessage = { job: { id: 'job_1' } }) {
  const calls: Call[] = [];
  const call: JobPostingCaller = async <T>(method: string, request: object, caller?: RecruiterCaller) => {
    calls.push({ method, request: request as Record<string, unknown>, caller });
    return response as T;
  };
  return { call, calls };
}

/** Mounts the router behind a stand-in for `authenticate`. */
async function withJobs(role: 'seeker' | 'recruiter', jobPosting: JobPostingCaller, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: role === 'recruiter' ? RECRUITER : SEEKER, role };
    next();
  });
  app.use('/api/jobs', createJobRoutes(jobPosting, 'co-test'));
  app.use(errorHandler);
  const { base, close } = await listen(app);
  try {
    await fn(base);
  } finally {
    await close();
  }
}

const recruiterCaller = { userId: RECRUITER, companyId: 'co-test' };

test('GET /api/jobs lists OPEN jobs without identity and returns the message unchanged', async () => {
  const { call, calls } = recording({ jobs: [{ id: 'job_1' }], total: 1 });
  await withJobs('seeker', call, async (base) => {
    const res = await fetch(`${base}/api/jobs?query=react`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jobs: [{ id: 'job_1' }], total: 1 });
  });
  assert.deepEqual(calls, [{ method: 'ListJobs', request: { status: 'JOB_STATUS_OPEN', query: 'react', limit: 100 }, caller: undefined }]);
});

test('GET /api/jobs/:jobId reads one job without identity', async () => {
  const { call, calls } = recording();
  await withJobs('seeker', call, async (base) => {
    assert.equal((await fetch(`${base}/api/jobs/job_1`)).status, 200);
  });
  assert.deepEqual(calls, [{ method: 'GetJob', request: { job_id: 'job_1' }, caller: undefined }]);
});

test('seekers cannot use /api/jobs/mine (403) and no RPC is made', async () => {
  const { call, calls } = recording();
  await withJobs('seeker', call, async (base) => {
    const res = await fetch(`${base}/api/jobs/mine`);
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
  assert.equal(calls.length, 0);
});

test('GET /api/jobs/mine lists the company jobs with recruiter identity; status defaults to any', async () => {
  const { call, calls } = recording({ jobs: [] });
  await withJobs('recruiter', call, async (base) => {
    await fetch(`${base}/api/jobs/mine?status=JOB_STATUS_DRAFT&query=dev`);
    await fetch(`${base}/api/jobs/mine`);
  });
  assert.deepEqual(calls, [
    { method: 'ListJobs', request: { company_id: 'co-test', status: 'JOB_STATUS_DRAFT', query: 'dev', limit: 100 }, caller: recruiterCaller },
    { method: 'ListJobs', request: { company_id: 'co-test', status: 'JOB_STATUS_UNSPECIFIED', query: '', limit: 100 }, caller: recruiterCaller },
  ]);
});

test('GET /api/jobs/mine/company returns the configured company without an RPC', async () => {
  const { call, calls } = recording();
  await withJobs('recruiter', call, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/jobs/mine/company`)).json(), { companyId: 'co-test' });
  });
  assert.equal(calls.length, 0);
});

test('recruiter writes map to the matching RPCs with the JSON body as `job`', async () => {
  const { call, calls } = recording();
  const job = { title: 'Backend Engineer', employment_type: 'EMPLOYMENT_TYPE_FULL_TIME' };
  await withJobs('recruiter', call, async (base) => {
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/jobs/mine`, { method: 'POST', headers: json, body: JSON.stringify(job) })).status, 200);
    await fetch(`${base}/api/jobs/mine/job_1`);
    await fetch(`${base}/api/jobs/mine/job_1`, { method: 'PUT', headers: json, body: JSON.stringify(job) });
    await fetch(`${base}/api/jobs/mine/job_1/publish`, { method: 'POST' });
    await fetch(`${base}/api/jobs/mine/job_1/close`, { method: 'POST' });
    await fetch(`${base}/api/jobs/mine/job_1/reopen`, { method: 'POST' });
    const del = await fetch(`${base}/api/jobs/mine/job_1`, { method: 'DELETE' });
    assert.equal(del.status, 204);
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.request]),
    [
      ['CreateJob', { job }],
      ['GetJob', { job_id: 'job_1' }],
      ['UpdateJob', { job_id: 'job_1', job }],
      ['PublishJob', { job_id: 'job_1' }],
      ['CloseJob', { job_id: 'job_1' }],
      ['ReopenJob', { job_id: 'job_1' }],
      ['DeleteJob', { job_id: 'job_1' }],
    ],
  );
  assert.ok(calls.every((c) => c.caller?.userId === RECRUITER && c.caller.companyId === 'co-test'));
});

test('resume template: raw upload with decoded file name, read without content, delete', async () => {
  const { call, calls } = recording({ template: { id: 'tpl_1' } });
  await withJobs('recruiter', call, async (base) => {
    const put = await fetch(`${base}/api/jobs/mine/job_1/resume-template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('แม่แบบ.pdf') },
      body: Buffer.from('%PDF-1.7'),
    });
    assert.equal(put.status, 200);
    await fetch(`${base}/api/jobs/mine/job_1/resume-template`);
    assert.equal((await fetch(`${base}/api/jobs/mine/job_1/resume-template`, { method: 'DELETE' })).status, 204);
  });
  const [attach, get, del] = calls;
  assert.equal(attach.method, 'AttachResumeTemplate');
  assert.equal(attach.request.job_id, 'job_1');
  assert.equal(attach.request.file_name, 'แม่แบบ.pdf');
  assert.equal(attach.request.content_type, 'application/pdf');
  assert.equal((attach.request.content as Buffer).toString('utf8'), '%PDF-1.7');
  assert.deepEqual([get.method, get.request], ['GetResumeTemplate', { job_id: 'job_1', include_content: false }]);
  assert.deepEqual([del.method, del.request], ['DeleteResumeTemplate', { job_id: 'job_1' }]);
});

test('AppErrors from the caller keep their status and body', async () => {
  const notFound: JobPostingCaller = async () => {
    throw new AppError('Job not found', 404, 'NOT_FOUND');
  };
  await withJobs('seeker', notFound, async (base) => {
    const res = await fetch(`${base}/api/jobs/job_missing`);
    assert.equal(res.status, 404);
    assert.deepEqual(await errorOf(res), { code: 'NOT_FOUND', message: 'Job not found' });
  });
});

test('malformed JSON body is 400 MALFORMED_JSON', async () => {
  const { call } = recording();
  await withJobs('recruiter', call, async (base) => {
    const res = await fetch(`${base}/api/jobs/mine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await errorOf(res)).code, 'MALFORMED_JSON');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/routes/job.routes'`.

- [ ] **Step 3: Create `src/routes/job.routes.ts`**

```ts
import express, { Router, type Request } from 'express';
import type { JobPostingCaller, RecruiterCaller } from '../grpc/job-posting.client';
import { requireRecruiter } from '../middleware/auth.middleware';

const LIST_LIMIT = 100;
// Job Posting accepts templates up to 2 MB; the extra room lets it answer with its own message.
const MAX_TEMPLATE_BYTES = 3 * 1024 * 1024;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function decodeFileName(header: string | undefined): string {
  if (!header) return '';
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * REST → gRPC translation for the Job Posting Service, mounted at /api/jobs.
 * Request bodies and responses are proto-shaped (snake_case, prefixed enums)
 * and passed through unchanged: the service does all validation and rules.
 */
export function createJobRoutes(jobPosting: JobPostingCaller, recruiterCompanyId: string): Router {
  const router = Router();
  const json = express.json({ limit: '1mb' });
  const raw = express.raw({ type: () => true, limit: MAX_TEMPLATE_BYTES });
  const recruiter = (req: Request): RecruiterCaller => ({ userId: req.user!.id, companyId: recruiterCompanyId });

  // --- recruiter: own company's jobs (mounted before /:jobId so "mine" is never a job id) ---
  const mine = Router();
  mine.use(requireRecruiter);

  mine.get('/', async (req, res) => {
    const request = {
      company_id: recruiterCompanyId,
      status: text(req.query.status) || 'JOB_STATUS_UNSPECIFIED',
      query: text(req.query.query),
      limit: LIST_LIMIT,
    };
    res.json(await jobPosting('ListJobs', request, recruiter(req)));
  });

  mine.get('/company', (_req, res) => {
    res.json({ companyId: recruiterCompanyId });
  });

  mine.post('/', json, async (req, res) => {
    res.json(await jobPosting('CreateJob', { job: req.body }, recruiter(req)));
  });

  mine.get('/:jobId', async (req, res) => {
    res.json(await jobPosting('GetJob', { job_id: req.params.jobId }, recruiter(req)));
  });

  mine.put('/:jobId', json, async (req, res) => {
    res.json(await jobPosting('UpdateJob', { job_id: req.params.jobId, job: req.body }, recruiter(req)));
  });

  mine.delete('/:jobId', async (req, res) => {
    await jobPosting('DeleteJob', { job_id: req.params.jobId }, recruiter(req));
    res.status(204).end();
  });

  const transitions = [
    ['publish', 'PublishJob'],
    ['close', 'CloseJob'],
    ['reopen', 'ReopenJob'],
  ] as const;
  for (const [action, method] of transitions) {
    mine.post(`/:jobId/${action}`, async (req, res) => {
      res.json(await jobPosting(method, { job_id: req.params.jobId }, recruiter(req)));
    });
  }

  mine.get('/:jobId/resume-template', async (req, res) => {
    res.json(await jobPosting('GetResumeTemplate', { job_id: req.params.jobId, include_content: false }, recruiter(req)));
  });

  mine.put('/:jobId/resume-template', raw, async (req, res) => {
    const request = {
      job_id: req.params.jobId,
      file_name: decodeFileName(req.get('x-file-name')),
      content_type: req.get('content-type') ?? '',
      content: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    };
    res.json(await jobPosting('AttachResumeTemplate', request, recruiter(req)));
  });

  mine.delete('/:jobId/resume-template', async (req, res) => {
    await jobPosting('DeleteResumeTemplate', { job_id: req.params.jobId }, recruiter(req));
    res.status(204).end();
  });

  router.use('/mine', mine);

  // --- any signed-in user: no identity is sent, so drafts are never returned ---
  router.get('/', async (req, res) => {
    res.json(await jobPosting('ListJobs', { status: 'JOB_STATUS_OPEN', query: text(req.query.query), limit: LIST_LIMIT }));
  });

  router.get('/:jobId', async (req, res) => {
    res.json(await jobPosting('GetJob', { job_id: req.params.jobId }));
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes tests/job.routes.test.ts
git commit -m "feat: add REST routes that translate to Job Posting gRPC calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: App assembly — proxy, CORS, logging, health, 404

**Files:**
- Create: `src/proxy/service-proxy.ts`, `src/middleware/cors.middleware.ts`, `src/middleware/logger.middleware.ts`, `src/app.ts`
- Test: `tests/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces:
  - `createServiceProxy(target: string, service: string)` → an Express-compatible middleware
  - `cors(allowedOrigin: string): RequestHandler`, `requestLogger: RequestHandler`
  - `interface AppDependencies { verifyClaims: ClaimsVerifier; jobPosting: JobPostingCaller; candidateProfileUrl: string; jobDiscoveryUrl: string; frontendUrl: string; recruiterCompanyId: string }`
  - `createApp(deps: AppDependencies): Express`

- [ ] **Step 1: Write the failing test `tests/app.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp, type AppDependencies } from '../src/app';
import type { JobPostingCaller } from '../src/grpc/job-posting.client';
import { errorOf, fakeVerifier, listen, SEEKER } from './helpers';

const ORIGIN = 'http://localhost:3000';

/** A downstream service that echoes what it received. */
function echoService(name: string) {
  const app = express();
  app.get('/api/missing', (_req, res) => {
    res.status(404).json({ error: { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' } });
  });
  app.all('/{*rest}', express.raw({ type: () => true }), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN); // must not leak through the gateway
    res.status(req.method === 'POST' ? 201 : 200).json({
      service: name,
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
    });
  });
  return app;
}

interface Echo {
  service: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const noJobs: JobPostingCaller = async <T>() => ({ jobs: [] }) as T;

async function withGateway(fn: (base: string) => Promise<void>, overrides: Partial<AppDependencies> = {}) {
  const profile = await listen(echoService('candidate-profile'));
  const discovery = await listen(echoService('job-discovery'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: noJobs,
      candidateProfileUrl: profile.base,
      jobDiscoveryUrl: discovery.base,
      frontendUrl: ORIGIN,
      recruiterCompanyId: 'co-test',
      ...overrides,
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await Promise.all([gateway.close(), profile.close(), discovery.close()]);
  }
}

const auth = { Authorization: 'Bearer seeker-token' };

test('GET /health needs no token', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', service: 'rolefit-api-gateway' });
  });
});

test('protected routes without a token are 401 MISSING_TOKEN; bad tokens are 401 INVALID_TOKEN', async () => {
  await withGateway(async (base) => {
    for (const path of ['/api/candidates/profiles/me', '/api/discovery/recommendations', '/api/jobs']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 401, path);
      assert.equal((await errorOf(res)).code, 'MISSING_TOKEN');
    }
    const bad = await fetch(`${base}/api/candidates/profiles/me`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
    assert.equal((await errorOf(bad)).code, 'INVALID_TOKEN');
  });
});

test('/api/candidates/* is forwarded to Candidate Profile /api/* with identity and query', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/candidates/profiles/me/skills?sort=name`, {
      headers: { ...auth, 'X-User-Id': 'spoofed' },
    });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'candidate-profile');
    assert.equal(echo.url, '/api/profiles/me/skills?sort=name');
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers.authorization, 'Bearer seeker-token');
  });
});

test('/api/discovery/* is forwarded to Job Discovery /api/* with the query string intact', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/discovery/jobs/search?query=react&employmentTypes=FULL_TIME%2CCONTRACT`, { headers: auth });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'job-discovery');
    assert.equal(echo.url, '/api/jobs/search?query=react&employmentTypes=FULL_TIME%2CCONTRACT');
  });
});

test('JSON and raw bodies, methods and downstream statuses pass through unchanged', async () => {
  await withGateway(async (base) => {
    const created = await fetch(`${base}/api/candidates/profiles/me`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pim', links: ['https://example.com'] }),
    });
    assert.equal(created.status, 201);
    const echo = (await created.json()) as Echo;
    assert.equal(echo.method, 'POST');
    assert.equal(echo.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(echo.body!), { name: 'Pim', links: ['https://example.com'] });

    const upload = await fetch(`${base}/api/candidates/profiles/me/import-resume`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/pdf', 'X-File-Name': 'cv.pdf' },
      body: '%PDF-1.7 bytes',
    });
    const uploadEcho = (await upload.json()) as Echo;
    assert.equal(uploadEcho.body, '%PDF-1.7 bytes');
    assert.equal(uploadEcho.headers['x-file-name'], 'cv.pdf');

    const patched = (await (await fetch(`${base}/api/candidates/profiles/me`, { method: 'PATCH', headers: auth })).json()) as Echo;
    assert.equal(patched.method, 'PATCH');

    const missing = await fetch(`${base}/api/candidates/missing`, { headers: auth });
    assert.equal(missing.status, 404);
    assert.deepEqual(await errorOf(missing), { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' });
  });
});

test('downstream CORS headers are replaced by the gateway ones', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/candidates/profiles/me`, { headers: { ...auth, Origin: ORIGIN } });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN); // exactly one value
  });
});

test('an unreachable service is 503 SERVICE_UNAVAILABLE', async () => {
  await withGateway(
    async (base) => {
      const res = await fetch(`${base}/api/candidates/profiles/me`, { headers: auth });
      assert.equal(res.status, 503);
      assert.deepEqual(await errorOf(res), {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The candidate profile service is unavailable. Please try again.',
      });
    },
    { candidateProfileUrl: 'http://127.0.0.1:1' },
  );
});

test('/api/jobs is served by the job routes', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/jobs`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jobs: [] });
  });
});

test('CORS preflight is answered by the gateway with the configured origin', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/candidates/profiles/me`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  });
});

test('unknown routes are 404 ROUTE_NOT_FOUND', async () => {
  await withGateway(async (base) => {
    const outside = await fetch(`${base}/nope`);
    assert.equal(outside.status, 404);
    assert.equal((await errorOf(outside)).code, 'ROUTE_NOT_FOUND');

    const insideApi = await fetch(`${base}/api/unknown`, { headers: auth });
    assert.equal(insideApi.status, 404);
    assert.equal((await errorOf(insideApi)).code, 'ROUTE_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/app'`.

- [ ] **Step 3: Create `src/middleware/cors.middleware.ts`**

```ts
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
```

- [ ] **Step 4: Create `src/middleware/logger.middleware.ts`**

```ts
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
```

- [ ] **Step 5: Create `src/proxy/service-proxy.ts`**

```ts
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
```

- [ ] **Step 6: Create `src/app.ts`**

```ts
import express, { type Express } from 'express';
import type { ClaimsVerifier } from './auth/supabase';
import type { JobPostingCaller } from './grpc/job-posting.client';
import { authenticate } from './middleware/auth.middleware';
import { cors } from './middleware/cors.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/logger.middleware';
import { createServiceProxy } from './proxy/service-proxy';
import { createJobRoutes } from './routes/job.routes';

export interface AppDependencies {
  /** Verifies Supabase access tokens. */
  verifyClaims: ClaimsVerifier;
  /** Calls the Job Posting Service over gRPC. */
  jobPosting: JobPostingCaller;
  candidateProfileUrl: string;
  jobDiscoveryUrl: string;
  /** The web frontend origin allowed by CORS, e.g. http://localhost:3000. */
  frontendUrl: string;
  /** Mock company for recruiter calls (the JWT has no company yet). */
  recruiterCompanyId: string;
}

/**
 * Builds the gateway app. Does not listen on a port, which keeps it easy to test.
 * No global body parser: proxied requests are streamed to the services untouched.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(cors(deps.frontendUrl));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'rolefit-api-gateway' });
  });

  app.use('/api', authenticate(deps.verifyClaims));
  app.use('/api/candidates', createServiceProxy(deps.candidateProfileUrl, 'candidate profile'));
  app.use('/api/discovery', createServiceProxy(deps.jobDiscoveryUrl, 'job discovery'));
  app.use('/api/jobs', createJobRoutes(deps.jobPosting, deps.recruiterCompanyId));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck clean. If the path tests show `/api/api/...` or a missing `/api`, the installed http-proxy-middleware passes a different path to `pathRewrite`; log `path` inside `pathRewrite`, then adjust the rewrite so `echo.url` is `/api/profiles/me/skills?sort=name`.

- [ ] **Step 8: Commit**

```bash
git add src tests/app.test.ts
git commit -m "feat: assemble gateway app with service proxies, CORS and logging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Server entry point, README, build and live smoke test

**Files:**
- Create: `src/server.ts`, `README.md`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createClaimsVerifier` (Task 2), `createJobPostingCaller` (Task 3), `createApp` (Task 5)

- [ ] **Step 1: Create `src/server.ts`**

```ts
import { createApp } from './app';
import { createClaimsVerifier } from './auth/supabase';
import { loadConfig } from './config/env';
import { createJobPostingCaller } from './grpc/job-posting.client';
import { logger } from './utils/logger';

const config = loadConfig();

const app = createApp({
  verifyClaims: createClaimsVerifier(config.supabaseUrl, config.supabasePublishableKey),
  jobPosting: createJobPostingCaller(config.jobPostingGrpcUrl),
  candidateProfileUrl: config.candidateProfileUrl,
  jobDiscoveryUrl: config.jobDiscoveryUrl,
  frontendUrl: config.frontendUrl,
  recruiterCompanyId: config.recruiterCompanyId,
});

app.listen(config.port, () => {
  logger.info(`API Gateway listening on http://localhost:${config.port}`);
  logger.info(`  /api/candidates/* → ${config.candidateProfileUrl}/api/*`);
  logger.info(`  /api/discovery/*  → ${config.jobDiscoveryUrl}/api/*`);
  logger.info(`  /api/jobs/*       → gRPC ${config.jobPostingGrpcUrl}`);
});
```

- [ ] **Step 2: Create `README.md`**

````markdown
# RoleFit API Gateway

The single public backend entry point for the RoleFit web frontend. It verifies the user's
Supabase access token, then routes the request to the right microservice. It holds no business logic.

## Architecture

```
Frontend ──Authorization: Bearer <Supabase JWT>──▶ API Gateway (:8080)
                                                     ├─ HTTP ─▶ Candidate Profile Service (:3001)
                                                     ├─ HTTP ─▶ Job Discovery Service     (:3002)
                                                     └─ gRPC ─▶ Job Posting Service       (:50052)
```

For every `/api/*` request the gateway:

1. verifies the Supabase JWT (`supabase.auth.getClaims()`), returning `401` if it is missing, invalid or expired;
2. sets `X-User-Id` to the verified user id (a client-sent value is replaced) and keeps `Authorization`;
3. forwards the request and returns the service's status and body unchanged.

## Services and routes

| Gateway route | Service | Upstream |
| --- | --- | --- |
| `GET /health` | gateway (no auth) | – |
| `/api/candidates/*` | Candidate Profile Service | `/api/*`, e.g. `/api/candidates/profiles/me` → `/api/profiles/me` |
| `/api/discovery/*` | Job Discovery Service | `/api/*`, e.g. `/api/discovery/recommendations` → `/api/recommendations` |
| `GET /api/jobs`, `GET /api/jobs/:jobId` | Job Posting Service | gRPC `ListJobs` (open jobs) / `GetJob` |
| `/api/jobs/mine/*` (recruiters only) | Job Posting Service | gRPC `ListJobs`, `CreateJob`, `GetJob`, `UpdateJob`, `DeleteJob`, `PublishJob`, `CloseJob`, `ReopenJob`, `Get/Attach/DeleteResumeTemplate` |

The Job Posting Service only speaks gRPC, so the gateway translates these REST calls to gRPC. Bodies and
responses are the proto messages as JSON (snake_case, enum names such as `JOB_STATUS_OPEN`), unchanged.

| Recruiter route | gRPC |
| --- | --- |
| `GET /api/jobs/mine?status=JOB_STATUS_DRAFT&query=` | `ListJobs` for the recruiter's company |
| `GET /api/jobs/mine/company` | – (returns `{ "companyId": … }`) |
| `POST /api/jobs/mine` (body: `JobInput`) | `CreateJob` |
| `GET / PUT / DELETE /api/jobs/mine/:jobId` | `GetJob` / `UpdateJob` / `DeleteJob` |
| `POST /api/jobs/mine/:jobId/publish` · `close` · `reopen` | `PublishJob` · `CloseJob` · `ReopenJob` |
| `GET / PUT / DELETE /api/jobs/mine/:jobId/resume-template` | `GetResumeTemplate` / `AttachResumeTemplate` (raw body, `Content-Type`, `X-File-Name`) / `DeleteResumeTemplate` |

## Local setup

Requires Node 20+ and the three services running locally.

```bash
npm install
cp .env.example .env   # then fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev            # or: npm run build && npm start
```

The gateway listens on `http://localhost:8080`. Start the services first:

| Service | Start | Port |
| --- | --- | --- |
| Candidate Profile | `npm run dev` in `rolefit-candidate-profile-service` | REST 3001, gRPC 50051 |
| Job Posting | `npm run dev` in `rolefit-job-posting-service` | gRPC 50052 |
| Job Discovery | `npm run dev` in `rolefit-job-discovery-service` | REST 3002 |
| Frontend | `npm run dev` in `rolefit-frontend` (`NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080`) | 3000 |

Job Posting's local `.env` sets `HTTP_PORT=3002`, which clashes with Job Discovery. That port only serves
Job Posting's own `/health`, so start Job Discovery first or change Job Posting's `HTTP_PORT` locally (for example to 3003).

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Gateway port |
| `FRONTEND_URL` | no | `http://localhost:3000` | The one origin allowed by CORS |
| `CANDIDATE_PROFILE_SERVICE_URL` | yes | – | e.g. `http://localhost:3001` |
| `JOB_DISCOVERY_SERVICE_URL` | yes | – | e.g. `http://localhost:3002` |
| `JOB_POSTING_GRPC_URL` | yes | – | gRPC `host:port`, e.g. `localhost:50052` |
| `SUPABASE_URL` | yes | – | Supabase project URL (Auth project) |
| `SUPABASE_PUBLISHABLE_KEY` | yes | – | Supabase publishable key (never the service role key) |
| `DEV_RECRUITER_COMPANY_ID` | no | `co-brightline` | Mock company sent to Job Posting for recruiter calls |
| `NODE_ENV` | no | `development` | `test` silences logs |

## Errors

Every gateway error uses the services' shape: `{ "error": { "code": "...", "message": "..." } }`.

| Status | Code | When |
| --- | --- | --- |
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | no, bad or expired access token |
| 403 | `FORBIDDEN` | a non-recruiter calls `/api/jobs/mine/*` |
| 404 | `ROUTE_NOT_FOUND` | unknown gateway route |
| 503 | `SERVICE_UNAVAILABLE` | a service is down or timed out |

Service errors (for example `404 PROFILE_NOT_FOUND`) are passed through unchanged. Job Posting gRPC errors
are mapped: `INVALID_ARGUMENT` → 400 `VALIDATION_ERROR` (with `details`), `NOT_FOUND` → 404,
`FAILED_PRECONDITION` → 409 `INVALID_STATE`, `PERMISSION_DENIED` → 403, `UNAUTHENTICATED` → 401.

## Example requests

```bash
TOKEN=<Supabase access token>   # e.g. from the browser: (await supabase.auth.getSession()).data.session.access_token

curl http://localhost:8080/health

curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/candidates/profiles/me

curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/discovery/jobs/search?query=react"

curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/jobs?query=react"
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run the build |
| `npm test` | Tests (node:test) with fake services |
| `npm run typecheck` | TypeScript check |
````

- [ ] **Step 3: Run tests, typecheck and build**

Run: `npm test && npm run typecheck && npm run build && ls dist/server.js`
Expected: tests PASS, typecheck clean, `dist/server.js` exists.

- [ ] **Step 4: Live smoke test against the real services**

Create `.env` from `.env.example`, copying `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` from the frontend's `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (same Auth project). Start the Candidate Profile, Job Posting and Job Discovery services, then `npm run dev` in the gateway. In another terminal:

```bash
curl -s http://localhost:8080/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/candidates/profiles/me
curl -s -H "Authorization: Bearer not-a-jwt" http://localhost:8080/api/jobs
```
Expected: `{"status":"ok","service":"rolefit-api-gateway"}`, then `401`, then `{"error":{"code":"INVALID_TOKEN",...}}`. Stop the gateway when done. If a service is not running, the matching route returns `503 SERVICE_UNAVAILABLE`; that is correct.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts README.md
git commit -m "feat: add gateway server entry point and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — gateway client

All commands in Tasks 7–11 run in `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`.

**Files:**
- Create: `src/lib/api/gateway.ts`, `src/lib/api/gateway.test.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/auth/supabase`, `ApiError`, `FieldError` from `./errors`
- Produces:
  - `interface GatewayRequestInit { json?: unknown; body?: BodyInit; headers?: HeadersInit; query?: URLSearchParams; serviceName?: string }`
  - `gatewayRequest<T>(method: string, path: string, init?: GatewayRequestInit): Promise<T>` — `path` starts with `/api/...`; 204 → `undefined`; throws `ApiError`

- [ ] **Step 1: Create a feature branch**

```bash
git status --short   # must be empty; if not, stop and ask the user
git checkout -b feat/api-gateway
```

- [ ] **Step 2: Write the failing test `src/lib/api/gateway.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { gatewayRequest } from "./gateway";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", "http://localhost:8080/");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gatewayRequest", () => {
  it("calls the gateway with the Supabase access token and the query string", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const data = await gatewayRequest("GET", "/api/discovery/recommendations", { query: new URLSearchParams({ limit: "3" }) });
    expect(data).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/discovery/recommendations?limit=3");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("sends no Authorization header when nobody is signed in", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await gatewayRequest("GET", "/api/jobs");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has("Authorization")).toBe(false);
  });

  it("serializes json bodies", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "p1" }));
    await gatewayRequest("POST", "/api/candidates/profiles/me", { json: { name: "Pim" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ name: "Pim" });
  });

  it("resolves 204 to undefined", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(gatewayRequest("DELETE", "/api/jobs/mine/job_1")).resolves.toBeUndefined();
  });

  it("turns an error body into an ApiError with field errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: "Some fields are invalid", details: [{ field: "title", message: "Is required" }] } }),
    );
    await expect(gatewayRequest("POST", "/api/jobs/mine", { json: {} })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
      fieldErrors: [{ field: "title", message: "Is required" }],
    });
  });

  it("uses the service name in fallback messages", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));
    await expect(gatewayRequest("GET", "/api/jobs", { serviceName: "job service" })).rejects.toMatchObject({
      code: "INTERNAL",
      status: 502,
      message: "The job service returned an error (502).",
    });

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await gatewayRequest("GET", "/api/jobs", { serviceName: "job service" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503, message: "Can't reach the job service. Please try again." });
  });

  it("fails with CONFIG_ERROR when the gateway URL is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", "");
    await expect(gatewayRequest("GET", "/api/jobs")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/api/gateway.test.ts`
Expected: FAIL — cannot resolve `./gateway`.

- [ ] **Step 4: Create `src/lib/api/gateway.ts`**

```ts
import { supabase } from "@/lib/auth/supabase";
import { ApiError, type FieldError } from "./errors";

// The one HTTP client for RoleFit's backend. Every request goes to the API
// Gateway with the signed-in user's Supabase access token; the gateway checks
// the token and routes the request to the right service.

export interface GatewayRequestInit {
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  query?: URLSearchParams;
  /** Used in error messages, e.g. "profile service". */
  serviceName?: string;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: FieldError[] };
}

function baseUrl(): string {
  // Must be read as a literal so Next can inline it into the browser bundle.
  const url = process.env.NEXT_PUBLIC_API_GATEWAY_URL;
  if (!url) {
    throw new ApiError("CONFIG_ERROR", "NEXT_PUBLIC_API_GATEWAY_URL is not set. Add it to .env.local and restart the dev server.");
  }
  return url.replace(/\/+$/, "");
}

/** The current access token; Supabase refreshes it before it expires. */
async function accessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

/** Calls `path` (e.g. "/api/candidates/profiles/me") on the gateway. Throws ApiError on failure. */
export async function gatewayRequest<T>(method: string, path: string, init: GatewayRequestInit = {}): Promise<T> {
  const service = init.serviceName ?? "RoleFit server";
  const qs = init.query?.toString();
  const url = `${baseUrl()}${path}${qs ? `?${qs}` : ""}`;

  const headers = new Headers(init.headers);
  const token = await accessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", `Can't reach the ${service}. Please try again.`, 503);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ErrorBody | null)?.error;
    throw new ApiError(err?.code ?? "INTERNAL", err?.message ?? `The ${service} returned an error (${res.status}).`, res.status, err?.details);
  }
  return data as T;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/api/gateway.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api/gateway.ts src/lib/api/gateway.test.ts
git commit -m "feat: add API gateway client that sends the Supabase access token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — Candidate Profile and Job Discovery through the gateway

**Files:**
- Modify: `src/lib/api/candidate-profile.ts:1-66`, `src/lib/api/job-discovery.ts:1-44`
- Test: `src/lib/api/candidate-profile.test.ts`, `src/lib/api/job-discovery.test.ts`

**Interfaces:**
- Consumes: `gatewayRequest` (Task 7)
- Produces: unchanged exported functions of both modules

- [ ] **Step 1: Update `src/lib/api/candidate-profile.test.ts` to expect gateway calls**

Make these exact edits:

1. Replace lines 1–22 (imports through the `afterEach` block) with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as profileApi from "./candidate-profile";
import { ApiError } from "./errors";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", "http://localhost:8080");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
```

2. Replace the first test (`"sends X-User-Id and parses the JSON response"`) with:

```ts
  it("calls the gateway with the access token and parses the JSON response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "p1", name: "Pim" }));
    const profile = await profileApi.getProfile();
    expect(profile).toEqual({ id: "p1", name: "Pim" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/candidates/profiles/me");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.has("X-User-Id")).toBe(false);
  });
```

3. Replace every `http://localhost:3001/api/profiles` with `http://localhost:8080/api/candidates/profiles` (2 places: the 204 test and the `.docx` upload test).

4. Replace the last test (`"fails with a clear message when the service URL is not configured"`) body's env line with `vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", "");` and rename it `"fails with a clear message when the gateway URL is not configured"`.

- [ ] **Step 2: Update `src/lib/api/job-discovery.test.ts` to expect gateway calls**

1. Replace lines 1–25 (imports through `afterEach`) with the same header as Step 1, but importing the discovery module and keeping the `job` fixture:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import * as discoveryApi from "./job-discovery";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const job = { id: "job_1", companyId: "co-brightline", title: "Frontend Developer", match: { score: 80 } };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", "http://localhost:8080/");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
```

2. Rename the first test to `"sends filters as query parameters with the access token and attaches the company"`, replace its expected URL prefix `http://localhost:3002/api/jobs/search?` with `http://localhost:8080/api/discovery/jobs/search?`, and replace `expect(new Headers(init.headers).get("X-User-Id")).toBe(USER);` with `expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");`.

3. In `"calls the recommendation, fit and match routes"` replace the three expected URLs with:

```ts
      "http://localhost:8080/api/discovery/recommendations?limit=3",
      "http://localhost:8080/api/discovery/jobs/job_1/fit",
      "http://localhost:8080/api/discovery/jobs/job_1/match",
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/api/candidate-profile.test.ts src/lib/api/job-discovery.test.ts`
Expected: FAIL — URLs still point at `:3001` / `:3002` (or `CONFIG_ERROR` for the unset service URLs).

- [ ] **Step 4: Rewrite the top of `src/lib/api/candidate-profile.ts`**

Replace lines 1–66 (everything from the first import down to and including the closing `}` of `async function request`) with:

```ts
import type {
  CandidatePreferences,
  CandidateProfile,
  Education,
  EducationInput,
  Experience,
  ExperienceInput,
  ExtractedProfile,
  ProfileBasics,
  ProfileDocument,
  Project,
  ProjectInput,
  Skill,
  SkillInput,
} from "@/lib/types";
import { ApiError } from "./errors";
import { gatewayRequest } from "./gateway";

// REST client for the Candidate Profile Service, reached through the API
// Gateway (/api/candidates/* → the service's /api/*). Every route works on the
// signed-in user's own profile (/profiles/me); the gateway tells the service who that is.

const DOC = "application/msword";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const request = <T>(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: HeadersInit } = {}) =>
  gatewayRequest<T>(method, `/api/candidates/profiles${path}`, { ...init, serviceName: "profile service" });
```

Everything from `// --- profile ---` downwards stays exactly as it is.

- [ ] **Step 5: Rewrite the top of `src/lib/api/job-discovery.ts`**

Replace lines 1–44 (imports through the closing `}` of `async function get`) with:

```ts
import { companyFor } from "@/lib/companies";
import type { JobPosting, JobSearchFilters, JobWithMatch, MatchResult } from "@/lib/types";
import { gatewayRequest } from "./gateway";

// REST client for the Job Discovery Service, reached through the API Gateway
// (/api/discovery/* → the service's /api/*). The service reads the seeker's
// profile and the open jobs over gRPC and does the matching.

const get = <T>(path: string, params?: URLSearchParams) =>
  gatewayRequest<T>("GET", `/api/discovery${path}`, { query: params, serviceName: "job discovery service" });
```

Everything from `type JobPostingWithMatch = …` downwards stays exactly as it is.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/api/candidate-profile.test.ts src/lib/api/job-discovery.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api/candidate-profile.ts src/lib/api/candidate-profile.test.ts src/lib/api/job-discovery.ts src/lib/api/job-discovery.test.ts
git commit -m "feat: call Candidate Profile and Job Discovery through the API gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — Job Posting through the gateway, remove gRPC and mock identity

**Files:**
- Move: `src/lib/grpc/job-mapper.ts` → `src/lib/api/job-mapper.ts`, `src/lib/grpc/job-mapper.test.ts` → `src/lib/api/job-mapper.test.ts`
- Rewrite: `src/lib/api/job-posting.ts`
- Create: `src/lib/api/job-posting.test.ts`
- Delete: `src/lib/api/job-posting-actions.ts`, `src/lib/grpc/job-posting-client.ts`, `src/lib/identity.ts`, `src/lib/identity.server.ts`, `proto/`
- Modify: `package.json`, `package-lock.json`, `next.config.ts`, `src/lib/types.ts:177`

**Interfaces:**
- Consumes: `gatewayRequest` (Task 7); gateway routes `/api/jobs`, `/api/jobs/:jobId`, `/api/jobs/mine…` (Task 4)
- Produces: the same exported functions and signatures `job-posting.ts` has today: `listMyJobs, getMyJob, createJob, updateJob, deleteJob, publishJob, closeJob, reopenJob, attachResumeTemplate, getResumeTemplate, deleteResumeTemplate, getRecruiterCompany, listOpenJobs, getJob`

- [ ] **Step 1: Move the mapper and drop its gRPC error code**

```bash
git mv src/lib/grpc/job-mapper.ts src/lib/api/job-mapper.ts
git mv src/lib/grpc/job-mapper.test.ts src/lib/api/job-mapper.test.ts
```

In `src/lib/api/job-mapper.ts`:
- Delete line 1 (`import { ApiError, type FieldError } from "@/lib/api/errors";`).
- Replace the header comment with:

```ts
// Pure mapping between the Job Posting proto messages (snake_case, prefixed
// enums, "" / UNSPECIFIED for "not set") as returned by the API Gateway, and
// the frontend types.
```
- Delete the `GRPC_STATUS` constant (with its doc comment).
- Delete everything after `toResumeTemplateInfo` (the `GrpcLikeError` interface, `readFieldErrors` and `grpcErrorToApiError`). The gateway does this mapping now.

In `src/lib/api/job-mapper.test.ts`:
- Change line 2 to `import { toJobPosting, toProtoJobInput, toProtoStatus, toResumeTemplateInfo } from "./job-mapper";`
- Delete the `grpcError` helper function and the whole `describe("grpcErrorToApiError", …)` block at the end of the file.

Run: `npx vitest run src/lib/api/job-mapper.test.ts`
Expected: the remaining mapper tests PASS.

- [ ] **Step 2: Write the failing test `src/lib/api/job-posting.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as jobsApi from "./job-posting";
import type { JobPostingInput } from "@/lib/types";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();
const GW = "http://localhost:8080";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const protoJob = {
  id: "job_1",
  recruiter_id: "u1",
  company_id: "co-brightline",
  title: "Frontend Developer",
  status: "JOB_STATUS_OPEN",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const input: JobPostingInput = {
  title: "Backend Engineer",
  description: "",
  responsibilities: [],
  requirements: { requiredSkills: [], preferredSkills: [], minimumExperienceYears: 0, educationLevel: "NONE", acceptedFields: [] },
  location: {},
  salary: { currency: "THB", visible: true },
  positionsAvailable: 1,
  requireCoverLetter: false,
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", GW);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("job posting client", () => {
  it("lists open jobs through the gateway and maps them with the company", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { jobs: [protoJob] }));
    const jobs = await jobsApi.listOpenJobs({ query: "react" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GW}/api/jobs?query=react`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
    expect(jobs[0]).toMatchObject({ id: "job_1", status: "OPEN", company: { id: "co-brightline", name: "Brightline Analytics" } });
  });

  it("reads one public job and one own job", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job: protoJob }));
    await jobsApi.getJob("job 1");
    await jobsApi.getMyJob("job_1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${GW}/api/jobs/job%201`, `${GW}/api/jobs/mine/job_1`]);
  });

  it("lists own jobs with the proto status filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { jobs: [] }));
    await jobsApi.listMyJobs({ status: "DRAFT", query: "dev" });
    await jobsApi.listMyJobs();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${GW}/api/jobs/mine?status=JOB_STATUS_DRAFT&query=dev`, `${GW}/api/jobs/mine`]);
  });

  it("creates and updates with a proto-shaped body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job: { ...protoJob, status: "JOB_STATUS_DRAFT" } }));
    const created = await jobsApi.createJob(input);
    await jobsApi.updateJob("job_1", input);
    expect(created.status).toBe("DRAFT");
    const [[createUrl, createInit], [updateUrl, updateInit]] = fetchMock.mock.calls;
    expect([createUrl, createInit.method]).toEqual([`${GW}/api/jobs/mine`, "POST"]);
    expect([updateUrl, updateInit.method]).toEqual([`${GW}/api/jobs/mine/job_1`, "PUT"]);
    expect(JSON.parse(createInit.body)).toMatchObject({ title: "Backend Engineer", requirements: { education_level: "EDUCATION_LEVEL_NONE" } });
  });

  it("publishes, closes, reopens and deletes", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(200, { job: protoJob }),
    );
    await jobsApi.publishJob("job_1");
    await jobsApi.closeJob("job_1");
    await jobsApi.reopenJob("job_1");
    await expect(jobsApi.deleteJob("job_1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `POST ${GW}/api/jobs/mine/job_1/publish`,
      `POST ${GW}/api/jobs/mine/job_1/close`,
      `POST ${GW}/api/jobs/mine/job_1/reopen`,
      `DELETE ${GW}/api/jobs/mine/job_1`,
    ]);
  });

  it("uploads a resume template as a raw body with type and encoded file name", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { template: { id: "tpl_1", file_name: "แม่แบบ.docx", content_type: "x", size_bytes: "2", created_at: "2026-10-10" } }),
    );
    const file = new File(["PK"], "แม่แบบ.docx", { type: "" });
    const info = await jobsApi.attachResumeTemplate("job_1", file);
    expect(info).toEqual({ id: "tpl_1", fileName: "แม่แบบ.docx", contentType: "x", sizeBytes: 2, createdAt: "2026-10-10" });
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method]).toEqual([`${GW}/api/jobs/mine/job_1/resume-template`, "PUT"]);
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(headers.get("X-File-Name")).toBe(encodeURIComponent("แม่แบบ.docx"));
    expect(init.body).toBe(file);
  });

  it("returns null when the job has no resume template", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: "NOT_FOUND", message: "No template" } }));
    expect(await jobsApi.getResumeTemplate("job_1")).toBeNull();
  });

  it("keeps the gateway's error code and field errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: "title: Is required", details: [{ field: "title", message: "Is required" }] } }),
    );
    await expect(jobsApi.publishJob("job_1")).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400, fieldErrors: [{ field: "title", message: "Is required" }] });
  });

  it("gets the recruiter company from the gateway", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { companyId: "co-brightline" }));
    const company = await jobsApi.getRecruiterCompany();
    expect(fetchMock.mock.calls[0][0]).toBe(`${GW}/api/jobs/mine/company`);
    expect(company.id).toBe("co-brightline");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/api/job-posting.test.ts`
Expected: FAIL — the current module calls Server Actions (gRPC), not `fetch`.

- [ ] **Step 4: Rewrite `src/lib/api/job-posting.ts`**

```ts
import { companyFor } from "@/lib/companies";
import type { Company, JobPosting, JobPostingInput, JobStatus, JobWithCompany, ResumeTemplateInfo } from "@/lib/types";
import { ApiError } from "./errors";
import { gatewayRequest } from "./gateway";
import { toJobPosting, toProtoJobInput, toProtoStatus, toResumeTemplateInfo } from "./job-mapper";

// What pages call for jobs. The API Gateway turns these REST calls into Job
// Posting Service gRPC calls; bodies and responses stay proto-shaped and are
// mapped here. Recruiter calls go to /api/jobs/mine (the gateway adds the
// recruiter identity), seeker calls to /api/jobs (open jobs only).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const request = <T>(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: HeadersInit; query?: URLSearchParams } = {}) =>
  gatewayRequest<T>(method, `/api/jobs${path}`, { ...init, serviceName: "job service" });

const withCompany = (job: JobPosting): JobWithCompany => ({ ...job, company: companyFor(job.companyId) });
const jobOf = (res: Msg): JobWithCompany => withCompany(toJobPosting(res.job));
const jobsOf = (res: Msg): JobWithCompany[] => (res.jobs ?? []).map((job: Msg) => withCompany(toJobPosting(job)));
const mine = (id: string, action = "") => `/mine/${encodeURIComponent(id)}${action}`;

function listQuery(opts: { status?: JobStatus; query?: string }): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", toProtoStatus(opts.status));
  if (opts.query) params.set("query", opts.query);
  return params;
}

// --- recruiter ---

export async function listMyJobs(opts: { status?: JobStatus; query?: string } = {}): Promise<JobWithCompany[]> {
  return jobsOf(await request<Msg>("GET", "/mine", { query: listQuery(opts) }));
}

export async function getMyJob(id: string): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("GET", mine(id)));
}

export async function createJob(input: JobPostingInput): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("POST", "/mine", { json: toProtoJobInput(input) }));
}

export async function updateJob(id: string, input: JobPostingInput): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("PUT", mine(id), { json: toProtoJobInput(input) }));
}

export async function deleteJob(id: string): Promise<void> {
  await request<void>("DELETE", mine(id));
}

export async function publishJob(id: string): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("POST", mine(id, "/publish")));
}

export async function closeJob(id: string): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("POST", mine(id, "/close")));
}

export async function reopenJob(id: string): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("POST", mine(id, "/reopen")));
}

export async function attachResumeTemplate(id: string, file: File): Promise<ResumeTemplateInfo> {
  const contentType = file.type || (file.name.toLowerCase().endsWith(".docx") ? DOCX : "application/pdf");
  const res = await request<Msg>("PUT", mine(id, "/resume-template"), {
    body: file,
    headers: { "Content-Type": contentType, "X-File-Name": encodeURIComponent(file.name) },
  });
  return toResumeTemplateInfo(res.template);
}

/** Metadata of the job's resume template, or null when it has none. */
export async function getResumeTemplate(id: string): Promise<ResumeTemplateInfo | null> {
  try {
    return toResumeTemplateInfo((await request<Msg>("GET", mine(id, "/resume-template"))).template);
  } catch (e) {
    if (e instanceof ApiError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

export async function deleteResumeTemplate(id: string): Promise<void> {
  await request<void>("DELETE", mine(id, "/resume-template"));
}

export async function getRecruiterCompany(): Promise<Company> {
  const { companyId } = await request<{ companyId: string }>("GET", "/mine/company");
  return companyFor(companyId);
}

// --- seeker / public ---

export async function listOpenJobs(opts: { query?: string } = {}): Promise<JobWithCompany[]> {
  return jobsOf(await request<Msg>("GET", "", { query: listQuery({ query: opts.query }) }));
}

export async function getJob(id: string): Promise<JobWithCompany> {
  return jobOf(await request<Msg>("GET", `/${encodeURIComponent(id)}`));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/api/job-posting.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 6: Delete the gRPC client, Server Actions, mock identity and proto**

```bash
git rm src/lib/api/job-posting-actions.ts src/lib/grpc/job-posting-client.ts src/lib/identity.ts src/lib/identity.server.ts
git rm -r proto
grep -rnE "lib/identity|seekerUserId|recruiterCaller|job-posting-actions|lib/grpc|server-only|@grpc" src scripts next.config.ts
```
Expected from grep: only `scripts/e2e-smoke.ts` (fixed in Task 10) and `next.config.ts` (next step). If anything under `src/` matches, update that import to the new module before going on.

- [ ] **Step 7: Remove the gRPC packages and Next.js gRPC settings**

```bash
npm uninstall @grpc/grpc-js @grpc/proto-loader server-only
```

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

In `src/lib/types.ts:177`, change the comment `/** Also the owner's user id (the seeker's X-User-Id). */` to `/** Also the owner's user id (the signed-in seeker's Supabase user id). */`.

- [ ] **Step 8: Run all frontend tests and lint**

Run: `npm test && npm run lint`
Expected: all vitest suites PASS (including `errors.test.ts`, unchanged), lint clean.

- [ ] **Step 9: Commit**

```bash
git add -A src package.json package-lock.json next.config.ts
git commit -m "feat: call Job Posting through the API gateway instead of gRPC Server Actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Frontend — env, README and e2e smoke script

**Files:**
- Modify: `.env.example`, `README.md:1-35`, `scripts/e2e-smoke.ts`
- Local only (gitignored, do not commit): `.env`

**Interfaces:**
- Consumes: the API modules from Tasks 8–9, `supabase` from `src/lib/auth/supabase.ts`

- [ ] **Step 1: Replace `.env.example`**

```env
# Copy this file to .env.local and fill in real values — the app throws at startup without them.

# Supabase project used for authentication only (RoleFit data lives in the backend services).
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=

# The API Gateway: the only backend the frontend calls (rolefit-api-gateway).
NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080
```

- [ ] **Step 2: Update the local `.env` (not committed)**

In `.env`, add `NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080` and delete the lines for `NEXT_PUBLIC_JOB_DISCOVERY_API_URL`, `NEXT_PUBLIC_CANDIDATE_PROFILE_API_URL`, `NEXT_PUBLIC_DEV_SEEKER_USER_ID`, `JOB_POSTING_GRPC_URL`, `DEV_RECRUITER_USER_ID`, `DEV_RECRUITER_COMPANY_ID` and their comments. Keep the two `NEXT_PUBLIC_SUPABASE_*` lines. Do the same in `.env.local` if it exists.
Verify: `git status --short` does not list `.env`.

- [ ] **Step 3: Update `README.md`**

Replace everything from the top of the file to just before `## Scripts` with:

````markdown
# RoleFit Frontend

Next.js web app for RoleFit (Job Seeker and Recruiter). The browser talks to **one** backend, the
[API Gateway](../rolefit-api-gateway) (`:8080`), with the signed-in user's Supabase access token
(`Authorization: Bearer …`). The gateway routes each request to a service:

| Gateway path | Service |
| --- | --- |
| `/api/candidates/*` | Candidate Profile Service (REST) |
| `/api/discovery/*` | Job Discovery Service (REST: search, recommendations, job fit) |
| `/api/jobs/*` | Job Posting Service (the gateway translates to gRPC) |

All calls go through `src/lib/api/gateway.ts`. Resume Preparation and Application are still browser-side
mocks, but they read the real jobs and profile (and Application snapshots the match from Job Discovery).

## Environment (`.env.local`)

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080
```

`NEXT_PUBLIC_*` values are built into the browser bundle: restart `npm run dev` (or rebuild) after changing them.

````

In the Scripts table, replace the e2e row with:

```markdown
| `npx tsx --conditions=react-server scripts/e2e-smoke.ts` | End-to-end smoke test through the running API Gateway and services. Needs `SMOKE_SEEKER_EMAIL`, `SMOKE_SEEKER_PASSWORD`, `SMOKE_RECRUITER_EMAIL`, `SMOKE_RECRUITER_PASSWORD` (existing Supabase accounts); deletes the seeker's profile and leaves one closed test job |
```

- [ ] **Step 4: Rewrite `scripts/e2e-smoke.ts` to sign in and use the gateway**

Replace the header comment and the `process.env…` defaults (lines 1–20) with:

```ts
// End-to-end smoke test: drives the frontend's API modules through the API Gateway.
//
//   API Gateway + Candidate Profile + Job Posting (seeded) + Job Discovery must be running.
//   npx tsx --conditions=react-server scripts/e2e-smoke.ts
//
// Env (read from the environment, then .env.local / .env):
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_API_GATEWAY_URL (default http://localhost:8080)
//   SMOKE_SEEKER_EMAIL / SMOKE_SEEKER_PASSWORD        an existing seeker account
//   SMOKE_RECRUITER_EMAIL / SMOKE_RECRUITER_PASSWORD  an existing recruiter account
//   SMOKE_COMPANY_ID (default co-brightline)          the gateway's DEV_RECRUITER_COMPANY_ID
// It deletes the seeker's profile. Its test job ends CLOSED (only drafts can be
// deleted), so run it against a dev database, not one you care about.

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file not present
  }
}
process.env.NEXT_PUBLIC_API_GATEWAY_URL ??= "http://localhost:8080";
const COMPANY = process.env.SMOKE_COMPANY_ID ?? "co-brightline";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}
```

(The `import { randomUUID } from "node:crypto";` line is removed — no longer used.)

Replace the body of `main()` from its first line down to just before `// --- Candidate Profile Service (REST) ---` with:

```ts
  const profile = await import("../src/lib/api/candidate-profile");
  const jobs = await import("../src/lib/api/job-posting");
  const discovery = await import("../src/lib/api/job-discovery");
  const { ApiError } = await import("../src/lib/api/errors");
  const { supabase } = await import("../src/lib/auth/supabase");

  const signInAs = async (who: "SEEKER" | "RECRUITER") => {
    await supabase.auth.signOut({ scope: "local" });
    const { error } = await supabase.auth.signInWithPassword({
      email: required(`SMOKE_${who}_EMAIL`),
      password: required(`SMOKE_${who}_PASSWORD`),
    });
    if (error) throw new Error(`sign-in as ${who.toLowerCase()} failed: ${error.message}`);
  };

  const rejects = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e) {
      expect(e instanceof ApiError && e.code === code, `expected ${code}, got ${e instanceof ApiError ? e.code : String(e)}`);
      return e as InstanceType<typeof ApiError>;
    }
    throw new Error(`expected ${code}, but it succeeded`);
  };

  await signInAs("SEEKER");
  await step("profile: start clean", async () => {
    await profile.deleteProfile().catch((e) => {
      if (!(e instanceof ApiError && e.code === "PROFILE_NOT_FOUND")) throw e;
    });
  });
```

Leave every Candidate Profile step unchanged. Replace everything from `// --- Job Posting Service (gRPC via Server Actions) ---` to the end of the cleanup step with:

```ts
  // --- Job Posting Service (gRPC behind the gateway) ---
  await signInAs("RECRUITER");
  let jobId = "";
  await step("jobs: recruiter list includes own drafts; public list is OPEN only", async () => {
    const mine = await jobs.listMyJobs();
    expect(mine.some((j) => j.status === "DRAFT"), "no draft in own list");
    expect(mine.every((j) => j.companyId === COMPANY), "other company in own list");
    const open = await jobs.listOpenJobs();
    expect(open.length > 0 && open.every((j) => j.status === "OPEN"), "public list not OPEN only");
    const q = await jobs.listOpenJobs({ query: "react" });
    expect(q.length > 0, "query returned nothing");
  });
  await step("jobs: create draft, publish needs full details, then publishes", async () => {
    const draft = await jobs.createJob({
      title: "E2E Backend Engineer", description: "", responsibilities: [],
      requirements: { requiredSkills: [], preferredSkills: [], minimumExperienceYears: 0, educationLevel: "NONE", acceptedFields: [] },
      location: {}, salary: { currency: "THB", visible: true }, positionsAvailable: 1, requireCoverLetter: false,
    });
    jobId = draft.id;
    expect(draft.status === "DRAFT" && /^job_[0-9A-Z]{26}$/.test(draft.id), `bad draft ${draft.id}`);
    const failed = await rejects(jobs.publishJob(jobId), "VALIDATION_ERROR");
    expect((failed.fieldErrors?.length ?? 0) >= 4, JSON.stringify(failed.fieldErrors));
    await jobs.updateJob(jobId, {
      title: "E2E Backend Engineer", description: "Build services", responsibilities: ["Write tests"],
      requirements: {
        requiredSkills: [{ name: "Python", level: "INTERMEDIATE", minimumYears: 1 }], preferredSkills: [{ name: "Docker", level: "BASIC" }],
        minimumExperienceYears: 1, educationLevel: "BACHELOR", acceptedFields: ["Computer Science"],
      },
      employmentType: "FULL_TIME", workArrangement: "HYBRID", location: { country: "Thailand", province: "Bangkok", district: "Pathum Wan" },
      salary: { minimum: 35000, maximum: 50000, currency: "THB", visible: true },
      applicationDeadline: "2099-10-31T16:59:59.000Z", positionsAvailable: 2, requireCoverLetter: false,
    });
    const open = await jobs.publishJob(jobId);
    expect(open.status === "OPEN" && !!open.publishedAt, "not published");
    const pub = await jobs.getJob(jobId);
    expect(pub.location.district === "Pathum Wan" && pub.salary.minimum === 35000, "public read mismatch");
  });
  await step("jobs: resume template attach, read, delete", async () => {
    const t = await jobs.attachResumeTemplate(jobId, new File(["%PDF-1.7 template"], "Template.pdf", { type: "application/pdf" }));
    expect(t.fileName === "Template.pdf" && t.sizeBytes === 17, JSON.stringify(t));
    expect((await jobs.getResumeTemplate(jobId))?.id === t.id, "template not found");
    await jobs.deleteResumeTemplate(jobId);
    expect((await jobs.getResumeTemplate(jobId)) === null, "template not deleted");
  });
  await step("jobs: close, reopen; deleting an open job is refused", async () => {
    expect((await jobs.closeJob(jobId)).status === "CLOSED", "not closed");
    expect((await jobs.reopenJob(jobId)).status === "OPEN", "not reopened");
    await rejects(jobs.deleteJob(jobId), "INVALID_STATE");
  });
  await step("jobs: unknown id is NOT_FOUND; Thai duplicate skill is a readable VALIDATION_ERROR", async () => {
    await rejects(jobs.getJob("job_does_not_exist"), "NOT_FOUND");
    const bad = await rejects(jobs.createJob({
      title: "ครู", description: "", responsibilities: [],
      requirements: {
        requiredSkills: [{ name: "ภาษาไทย", level: "BASIC", minimumYears: 0 }, { name: "ภาษาไทย", level: "BASIC", minimumYears: 0 }],
        preferredSkills: [], minimumExperienceYears: 0, educationLevel: "NONE", acceptedFields: [],
      },
      location: {}, salary: { currency: "THB", visible: true }, positionsAvailable: 1, requireCoverLetter: false,
    }), "VALIDATION_ERROR");
    expect(bad.fieldErrors?.[0]?.message.includes("ภาษาไทย"), JSON.stringify(bad.fieldErrors));
  });
  await step("jobs: seekers are refused recruiter routes", async () => {
    await signInAs("SEEKER");
    await rejects(jobs.listMyJobs(), "FORBIDDEN");
  });

  // --- Job Discovery Service (REST; reads the two services above over gRPC) ---
  await step("discovery: match real profile vs real job", async () => {
    const m = await discovery.getMatchResult(jobId);
    expect(m.score > 0 && m.missingSkills.includes("Python") && m.explanation !== "", JSON.stringify(m));
  });
  await step("discovery: fit, search and recommendations include the job", async () => {
    const fit = await discovery.evaluateJobFit(jobId);
    expect(fit.id === jobId && fit.company.id === fit.companyId, JSON.stringify(fit));
    const found = await discovery.searchJobs({ query: fit.title });
    expect(found.some((j) => j.id === jobId), `search for "${fit.title}" missed ${jobId}`);
    const recs = await discovery.getRecommendations(100);
    expect(recs.some((j) => j.id === jobId), "recommendations missed the job");
    expect(recs.every((j, i) => i === 0 || recs[i - 1].match.score >= j.match.score), "not sorted by score");
  });
  await step("discovery: unknown job is 404", async () => {
    await rejects(discovery.getMatchResult("job_does_not_exist"), "JOB_NOT_FOUND");
  });

  // --- clean up what this run created ---
  await step("cleanup: close e2e job, delete profile", async () => {
    await profile.deleteProfile();
    expect((await profile.getProfile()) === null, "profile still there");
    await signInAs("RECRUITER");
    await jobs.closeJob(jobId);
  });
```

Keep the final `console.log(...)` / `process.exit(...)` lines and `void main();` unchanged.

- [ ] **Step 5: Type-check the script and run lint/tests**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test`
Expected: no type errors (`tsconfig.json` includes `**/*.ts`, so `scripts/e2e-smoke.ts` is checked), lint clean, tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md scripts/e2e-smoke.ts
git commit -m "docs: point the frontend env, README and e2e smoke test at the API gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verification — build, no direct service URLs, end-to-end

**Files:** none changed unless a check fails.

- [ ] **Step 1: Frontend build**

Run (in `rolefit-frontend`): `npm run build`
Expected: `next build` completes with no errors.

- [ ] **Step 2: Prove the frontend no longer references individual services**

Run (in `rolefit-frontend`):
```bash
grep -rnE "localhost:300[0-9]|localhost:5005[0-9]|CANDIDATE_PROFILE_API_URL|JOB_DISCOVERY_API_URL|JOB_POSTING_GRPC_URL|X-User-Id|DEV_SEEKER|DEV_RECRUITER|@grpc|job-posting-actions" src scripts next.config.ts .env.example package.json || echo "CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 3: Gateway full check**

Run (in `rolefit-api-gateway`): `npm test && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 4: Manual end-to-end (needs real accounts and services)**

1. Start Candidate Profile (`:3001`), Job Posting (gRPC `:50052`, seeded with `npm run seed`), Job Discovery (`:3002`), the gateway (`:8080`) and the frontend (`:3000`).
2. In the browser, open DevTools → Network, sign in as a seeker: open the profile, job search and a job detail page. Every API request goes to `localhost:8080` with `Authorization: Bearer …`; none go to `:3001`/`:3002`.
3. Sign in as a recruiter: open the jobs list, create a draft, publish it. Requests go to `localhost:8080/api/jobs/mine…`.
4. Optional: run the smoke test with real accounts:
   `SMOKE_SEEKER_EMAIL=… SMOKE_SEEKER_PASSWORD=… SMOKE_RECRUITER_EMAIL=… SMOKE_RECRUITER_PASSWORD=… npx tsx --conditions=react-server scripts/e2e-smoke.ts`
   Expected: `ALL PASSED`.

Note: Candidate Profile keeps working in both `AUTH_MODE=mock` and `AUTH_MODE=jwt`, because the gateway sends both `X-User-Id` and `Authorization`. Profiles created under the old mock seeker UUID are not visible to the real user.

- [ ] **Step 5: Report**

List the changed files in both repos (`git -C ../rolefit-api-gateway log --stat --oneline main`, `git log --stat --oneline dev..feat/api-gateway`) and give the user the run instructions and the checklist from the spec.
