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

async function withGateway(fn: (base: string) => Promise<void>) {
  const company = await listen(echoService('company'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: noJobs,
      candidateProfileUrl: 'http://127.0.0.1:1',
      jobDiscoveryUrl: 'http://127.0.0.1:1',
      applicationServiceUrl: 'http://127.0.0.1:1',
      notificationServiceUrl: 'http://127.0.0.1:1',
      resumePreparationUrl: 'http://127.0.0.1:1',
      companyServiceUrl: company.base,
      frontendUrl: 'http://localhost:3000',
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await Promise.all([gateway.close(), company.close()]);
  }
}

const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

test('a seeker cannot change the company profile', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/companies/me`, { method: 'PUT', headers: as('seeker-token'), body: '{}' });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
});

test('a seeker cannot read the recruiter profile', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/recruiters/me`, { headers: as('seeker-token') });
    assert.equal(res.status, 403);
  });
});

test('a recruiter without a company is rejected', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/companies/me`, { headers: as('recruiter-no-company-token') });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'NO_COMPANY');
  });
});

test('recruiter GET /me reaches the service with verified identity, company id and encoded company name', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/companies/me`, {
      headers: as('recruiter-token', { 'X-Company-Name': 'Evil Inc', 'X-Company-Id': 'co-evil-000000', 'X-User-Role': 'admin' }),
    });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'company');
    assert.equal(echo.url, '/api/companies/me');
    assert.equal(echo.headers['x-user-id'], RECRUITER);
    assert.equal(echo.headers['x-user-role'], 'recruiter');
    assert.equal(echo.headers['x-company-id'], COMPANY_ID);
    assert.equal(echo.headers['x-company-name'], encodeURIComponent('Acme Corp'));
  });
});

test('a client-sent X-Company-Name is removed when the token has no company name', async () => {
  await withGateway(async (base) => {
    const echo = (await (await fetch(`${base}/api/companies/co-acme-1a2b3c`, { headers: as('seeker-token', { 'X-Company-Name': 'Evil Inc' }) })).json()) as Echo;
    assert.equal(echo.headers['x-company-name'], undefined);
  });
});

test('recruiter PUT /me forwards method and body', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/companies/me`, {
      method: 'PUT',
      headers: as('recruiter-token', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ industry: 'Software' }),
    });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'PUT');
    assert.equal(echo.url, '/api/companies/me');
    assert.deepEqual(JSON.parse(echo.body!), { industry: 'Software' });
  });
});

test('any signed-in user can read a company by id', async () => {
  await withGateway(async (base) => {
    for (const token of ['seeker-token', 'recruiter-token']) {
      const res = await fetch(`${base}/api/companies/co-acme-1a2b3c`, { headers: as(token) });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as Echo).url, '/api/companies/co-acme-1a2b3c');
    }
  });
});

test('recruiter profile routes are forwarded for recruiters', async () => {
  await withGateway(async (base) => {
    const get = (await (await fetch(`${base}/api/recruiters/me`, { headers: as('recruiter-token') })).json()) as Echo;
    assert.equal(get.url, '/api/recruiters/me');
    const put = (await (await fetch(`${base}/api/recruiters/me`, { method: 'PUT', headers: as('recruiter-token') })).json()) as Echo;
    assert.equal(put.method, 'PUT');
  });
});

test('unauthenticated requests get 401 and unlisted company paths 404', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/companies/me`);
    assert.equal(res.status, 401);
    assert.equal((await fetch(`${base}/api/companies/a/b`, { headers: as('seeker-token') })).status, 404);
  });
});
