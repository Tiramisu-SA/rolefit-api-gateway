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

test('recruiter status update forwards method and body with verified identity, replacing forged headers', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/app_1/status`, {
      method: 'PATCH',
      headers: as('recruiter-token', { 'Content-Type': 'application/json', ...forged }),
      body: JSON.stringify({ status: 'Under review', note: 'Review started' }),
    });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'PATCH');
    assert.equal(echo.url, '/api/applications/app_1/status');
    assert.deepEqual(JSON.parse(echo.body!), { status: 'Under review', note: 'Review started' });
    assert.equal(echo.headers['x-user-id'], RECRUITER);
    assert.equal(echo.headers['x-user-role'], 'recruiter');
    assert.equal(echo.headers['x-company-id'], COMPANY_ID);
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

test('a service refusal for another company reaches the client unchanged', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/app_foreign/status`, {
      method: 'PATCH',
      headers: as('recruiter-token', { 'Content-Type': 'application/json' }),
      body: '{"status":"Offer"}',
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await errorOf(res), { code: 'FORBIDDEN', message: 'Application belongs to another company' });
  });
});

test('a token without a role cannot read an application', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications/app_1`, { headers: as('no-role-token') });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
});

test('wrong roles are refused at the gateway', async () => {
  await withGateway(async (base) => {
    const expectRefused = async (res: Response, code: string) => {
      assert.equal(res.status, 403);
      assert.equal((await errorOf(res)).code, code);
    };
    await expectRefused(
      await fetch(`${base}/api/applications/app_1/status`, {
        method: 'PATCH',
        headers: as('seeker-token', { 'Content-Type': 'application/json' }),
        body: '{"status":"Offer"}',
      }),
      'FORBIDDEN',
    );
    await expectRefused(await fetch(`${base}/api/applications?jobId=job_1`, { headers: as('seeker-token') }), 'FORBIDDEN');
    await expectRefused(await fetch(`${base}/api/applications/mine`, { headers: as('recruiter-token') }), 'FORBIDDEN');
    await expectRefused(
      await fetch(`${base}/api/applications/app_1/status`, { method: 'PATCH', headers: as('recruiter-no-company-token') }),
      'NO_COMPANY',
    );
  });
});

test('seeker submit is forwarded to POST /api/applications with body and verified identity', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications`, {
      method: 'POST',
      headers: as('seeker-token', { 'Content-Type': 'application/json', ...forged }),
      body: JSON.stringify({ jobId: 'job_1', coverLetter: 'Hello' }),
    });
    assert.equal(res.status, 201);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/api/applications');
    assert.deepEqual(JSON.parse(echo.body!), { jobId: 'job_1', coverLetter: 'Hello' });
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
    assert.equal(echo.headers['x-company-id'], undefined);
    assert.equal(echo.headers.authorization, 'Bearer seeker-token');
  });
});

test('recruiters cannot submit applications', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications`, { method: 'POST', headers: as('recruiter-token', { 'Content-Type': 'application/json' }), body: '{"jobId":"job_1"}' });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
});

test('unsupported routes are a gateway 404 and are not forwarded', async () => {
  await withGateway(async (base) => {
    const delete_app = await fetch(`${base}/api/applications/app_1`, { method: 'DELETE', headers: as('seeker-token') });
    assert.equal(delete_app.status, 404);
    assert.equal((await errorOf(delete_app)).code, 'ROUTE_NOT_FOUND');
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
