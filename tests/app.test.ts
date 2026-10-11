import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type AppDependencies } from '../src/app';
import type { JobPostingCaller } from '../src/grpc/job-posting.client';
import { echoService, errorOf, fakeVerifier, listen, SEEKER } from './helpers';

const ORIGIN = 'http://localhost:3000';

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
      applicationServiceUrl: 'http://127.0.0.1:1',
      frontendUrl: ORIGIN,
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
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    assert.equal(res.headers.get('access-control-expose-headers'), null);
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
