# Application Service Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the Application Service's four endpoints through the gateway with verified identity headers.

**Architecture:** `authenticate` injects `x-user-id` / `x-user-role` / `x-company-id` from the verified token on every request; a new `/api/applications` router role-checks each of the four endpoints and streams them to the service with `createServiceProxy`, which gains an `upstreamPrefix` option so the `/api/applications` prefix is kept.

**Tech Stack:** TypeScript, Express 5, http-proxy-middleware 3, node:test.

**Spec:** `docs/superpowers/specs/2026-10-11-application-service-routes-design.md`

## Global Constraints

- Repo `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`, branch `main` (the user asked to keep working on the current branch).
- Do NOT modify backend services or the frontend. No business logic in the gateway.
- Env: `APPLICATION_SERVICE_URL=http://localhost:3004` (required, http(s) URL).
- Upstream paths keep `/api/applications`; bare `/` (± query) maps to the prefix itself.
- Error body: `{ "error": { "code": string, "message": string } }`. Service down message: `The application service is unavailable. Please try again.`
- Never commit `.env`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Quote globs in zsh.

---

### Task 1: Application Service routes

**Files:**
- Modify: `src/middleware/auth.middleware.ts`, `src/proxy/service-proxy.ts`, `src/app.ts`, `src/server.ts`, `src/config/env.ts`, `.env.example`, `README.md`
- Create: `src/routes/application.routes.ts`, `tests/applications.test.ts`
- Modify tests: `tests/helpers.ts`, `tests/app.test.ts`, `tests/auth.test.ts`, `tests/env.test.ts`

**Interfaces:**
- Produces: `requireSeeker`, `requireCompanyIfRecruiter` middleware; `createServiceProxy(target, service, upstreamPrefix?)`; `createApplicationRoutes(applicationServiceUrl: string): Router`; `AppDependencies.applicationServiceUrl`; `GatewayConfig.applicationServiceUrl`; `tests/helpers.ts` `echoService(name)`.

- [ ] **Step 1: Move `echoService` into `tests/helpers.ts`**

Cut the `echoService` function from `tests/app.test.ts`, export it from `tests/helpers.ts` (add `import express from 'express';` there), and import it in `app.test.ts`. Add one route to it, next to the existing `/api/missing` route:

```ts
  app.get('/api/applications/missing', (_req, res) => {
    res.status(404).json({ error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found' } });
  });
```
The echo handler's CORS headers and `ORIGIN` usage: keep the function self-contained (it must not depend on `app.test.ts` constants). In `app.test.ts` add `applicationServiceUrl: 'http://127.0.0.1:1'` to the `createApp({...})` call in `withGateway`.

- [ ] **Step 2: Write failing tests**

`tests/env.test.ts`: add `APPLICATION_SERVICE_URL: 'http://localhost:3004/'` to `valid`; in the first test assert `config.applicationServiceUrl === 'http://localhost:3004'`; add `'APPLICATION_SERVICE_URL is required'` to the list in the "reports every missing or invalid variable" test.

`tests/auth.test.ts`: extend the `/echo` handler's JSON with `xUserRole: req.get('x-user-role') ?? null`. Update the seeker test's expected body to include `xUserRole: 'seeker'` and add `'X-User-Role': 'recruiter'` to its request headers (spoof must be replaced). Append:

```ts
test('recruiter identity headers come from the token, replacing client values', async () => {
  const { body } = await call('/echo', {
    Authorization: 'Bearer recruiter-token',
    'X-User-Role': 'admin',
    'X-Company-Id': 'co-evil-000000',
  });
  assert.equal(body.xUserId, RECRUITER_ID);
  assert.equal(body.xUserRole, 'recruiter');
  assert.equal(body.xCompanyId, COMPANY_ID);
});
```

`tests/applications.test.ts` (new):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import type { JobPostingCaller } from '../src/grpc/job-posting.client';
import { COMPANY_ID, echoService, errorOf, fakeVerifier, listen, RECRUITER, SEEKER } from './helpers';

const noJobs: JobPostingCaller = async <T>() => ({ jobs: [] }) as T;

interface Echo {
  service: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

async function withGateway(fn: (base: string) => Promise<void>, applicationServiceUrl?: string) {
  const application = await listen(echoService('application'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: noJobs,
      candidateProfileUrl: 'http://127.0.0.1:1',
      jobDiscoveryUrl: 'http://127.0.0.1:1',
      applicationServiceUrl: applicationServiceUrl ?? application.base,
      frontendUrl: 'http://localhost:3000',
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await Promise.all([gateway.close(), application.close()]);
  }
}

const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const forged = { 'X-User-Id': 'forged', 'X-User-Role': 'admin', 'X-Company-Id': 'co-evil-000000' };

test('seeker GET /mine is forwarded with the prefix kept and verified identity only', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/mine`, { headers: as('seeker-token', forged) });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'application');
    assert.equal(echo.url, '/api/applications/mine');
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
    assert.equal(echo.headers['x-company-id'], undefined);
  });
});

test('recruiter applicant list keeps the query and gets the company from the token', async () => {
  await withGateway(async (base) => {
    const echo = (await (await fetch(`${base}/api/applications?jobId=job_1`, { headers: as('recruiter-token', forged) })).json()) as Echo;
    assert.equal(echo.url, '/api/applications?jobId=job_1');
    assert.equal(echo.headers['x-user-id'], RECRUITER);
    assert.equal(echo.headers['x-user-role'], 'recruiter');
    assert.equal(echo.headers['x-company-id'], COMPANY_ID);
  });
});

test('recruiter status update forwards method and JSON body unchanged', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/app_1/status`, {
      method: 'PATCH',
      headers: as('recruiter-token', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'Under review', note: 'Review started' }),
    });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'PATCH');
    assert.equal(echo.url, '/api/applications/app_1/status');
    assert.deepEqual(JSON.parse(echo.body!), { status: 'Under review', note: 'Review started' });
  });
});

test('one application can be read by a seeker or a recruiter with a company', async () => {
  await withGateway(async (base) => {
    assert.equal((await fetch(`${base}/api/applications/app_1`, { headers: as('seeker-token') })).status, 200);
    assert.equal((await fetch(`${base}/api/applications/app_1`, { headers: as('recruiter-token') })).status, 200);
    const noCompany = await fetch(`${base}/api/applications/app_1`, { headers: as('recruiter-no-company-token') });
    assert.equal(noCompany.status, 403);
    assert.equal((await errorOf(noCompany)).code, 'NO_COMPANY');
  });
});

test('wrong roles are refused at the gateway', async () => {
  await withGateway(async (base) => {
    const seekerWrite = await fetch(`${base}/api/applications/app_1/status`, {
      method: 'PATCH',
      headers: as('seeker-token', { 'Content-Type': 'application/json' }),
      body: '{"status":"Offer"}',
    });
    assert.equal(seekerWrite.status, 403);
    assert.equal((await errorOf(seekerWrite)).code, 'FORBIDDEN');
    assert.equal((await fetch(`${base}/api/applications?jobId=job_1`, { headers: as('seeker-token') })).status, 403);
    assert.equal((await fetch(`${base}/api/applications/mine`, { headers: as('recruiter-token') })).status, 403);
    const noCompanyWrite = await fetch(`${base}/api/applications/app_1/status`, { method: 'PATCH', headers: as('recruiter-no-company-token') });
    assert.equal((await errorOf(noCompanyWrite)).code, 'NO_COMPANY');
  });
});

test('unsupported routes are a gateway 404 and are not forwarded', async () => {
  await withGateway(async (base) => {
    const submit = await fetch(`${base}/api/applications`, { method: 'POST', headers: as('seeker-token') });
    assert.equal(submit.status, 404);
    assert.equal((await errorOf(submit)).code, 'ROUTE_NOT_FOUND');
    const deep = await fetch(`${base}/api/applications/app_1/history`, { headers: as('seeker-token') });
    assert.equal((await errorOf(deep)).code, 'ROUTE_NOT_FOUND');
  });
});

test('service error statuses pass through; missing token is 401; service down is 503', async () => {
  await withGateway(async (base) => {
    const missing = await fetch(`${base}/api/applications/missing`, { headers: as('seeker-token') });
    assert.equal(missing.status, 404);
    assert.equal((await errorOf(missing)).code, 'APPLICATION_NOT_FOUND');
    assert.equal((await fetch(`${base}/api/applications/mine`)).status, 401);
  });
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/mine`, { headers: as('seeker-token') });
    assert.equal(res.status, 503);
    assert.deepEqual(await errorOf(res), { code: 'SERVICE_UNAVAILABLE', message: 'The application service is unavailable. Please try again.' });
  }, 'http://127.0.0.1:1');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (missing `applicationServiceUrl`, `x-user-role` not set, `/api/applications` not routed).

- [ ] **Step 4: Implement**

`src/middleware/auth.middleware.ts`:
- In `authenticate`, replace `delete req.headers['x-company-id'];` and the `x-user-id` line with:

```ts
    // Downstream services trust these headers, so they only ever carry verified values.
    delete req.headers['x-user-role'];
    delete req.headers['x-company-id'];
    req.headers['x-user-id'] = claims.sub;
    if (req.user.role) req.headers['x-user-role'] = req.user.role;
    if (companyId) req.headers['x-company-id'] = companyId;
```
- Update the doc comment above `authenticate` to say it sets `X-User-Id`, `X-User-Role` and `X-Company-Id` from the token (client values are always replaced or removed).
- Append:

```ts
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
```

`src/proxy/service-proxy.ts`:
- Signature: `export function createServiceProxy(target: string, service: string, upstreamPrefix = '/api') {`
- Replace the `pathRewrite` line and its comment with:

```ts
    // The path seen here is relative to the mount, e.g. /profiles/me under /api/candidates.
    // A bare "/" (with or without a query) maps to the prefix itself: /?jobId=1 → /api/applications?jobId=1.
    pathRewrite: (path) => (path === '/' || path.startsWith('/?') ? upstreamPrefix + path.slice(1) : upstreamPrefix + path),
```
- Doc comment: mention the `upstreamPrefix` (default `/api`), e.g. the Application Service keeps `/api/applications`.

`src/routes/application.routes.ts` (new):

```ts
import { Router } from 'express';
import { requireCompany, requireCompanyIfRecruiter, requireRecruiter, requireSeeker } from '../middleware/auth.middleware';
import { createServiceProxy } from '../proxy/service-proxy';

/**
 * The four Application Service endpoints, mounted at /api/applications and
 * forwarded to the same path upstream. Anything else under /api/applications
 * (for example submitting, which the service doesn't offer yet) falls through
 * to the gateway's 404. The service repeats every role and ownership check.
 */
export function createApplicationRoutes(applicationServiceUrl: string): Router {
  const router = Router();
  const proxy = createServiceProxy(applicationServiceUrl, 'application', '/api/applications');

  router.get('/mine', requireSeeker, proxy);
  router.get('/', requireRecruiter, requireCompany, proxy);
  router.get('/:applicationId', requireCompanyIfRecruiter, proxy);
  router.patch('/:applicationId/status', requireRecruiter, requireCompany, proxy);

  return router;
}
```

`src/app.ts`: add `/** Application Service REST base URL (still in development). */ applicationServiceUrl: string;` to `AppDependencies` (after `jobDiscoveryUrl`), import `createApplicationRoutes`, and mount `app.use('/api/applications', createApplicationRoutes(deps.applicationServiceUrl));` after the `/api/jobs` line.

`src/config/env.ts`: add `/** Application Service REST base URL, no trailing slash. */ applicationServiceUrl: string;` to `GatewayConfig` and `applicationServiceUrl: httpUrl('APPLICATION_SERVICE_URL'),` after `jobDiscoveryUrl` in `loadConfig`.

`src/server.ts`: pass `applicationServiceUrl: config.applicationServiceUrl,` and add a startup log line `logger.info(\`  /api/applications/* → ${config.applicationServiceUrl}/api/applications/*\`);` after the discovery line.

`.env.example`: after `JOB_DISCOVERY_SERVICE_URL`, add:
```env
# Application Service (still in development; routes return 503 until it runs).
APPLICATION_SERVICE_URL=http://localhost:3004
```

`README.md`:
- Architecture diagram: add a branch `├─ HTTP ─▶ Application Service       (:3004, in development)` (keep alignment with the existing lines; Job Posting stays last).
- Step 2 of the per-request list: say the gateway sets `X-User-Id`, `X-User-Role` and (for recruiters) `X-Company-Id` from the token, replacing client values.
- Routes table: add rows for the four endpoints (`GET /api/applications/mine` seeker; `GET /api/applications?jobId=` recruiter; `GET /api/applications/:applicationId` seeker or recruiter; `PATCH /api/applications/:applicationId/status` recruiter) → Application Service, same path. Add one sentence: other paths under `/api/applications` (e.g. submitting) are a gateway 404.
- Local setup services table: add `Application | per its own repo (owner: Pun) | REST 3004 (in development)`.
- Env table: `| APPLICATION_SERVICE_URL | yes | – | e.g. http://localhost:3004 |` (backtick style as the other rows).

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass (previous 46 plus the new ones), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src tests README.md .env.example
git commit -m "feat: route the Application Service through the gateway with verified identity headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
