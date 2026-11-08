import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import type { JobPostingCaller } from '../src/grpc/job-posting.client';
import { echoService, errorOf, fakeVerifier, listen, SEEKER } from './helpers';

const noJobs: JobPostingCaller = async <T>() => ({ jobs: [] }) as T;

interface Echo {
  service: string;
  method: string;
  url: string;
  headers: Record<string, string>;
}

async function withGateway(fn: (base: string) => Promise<void>) {
  const notification = await listen(echoService('notification'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: noJobs,
      candidateProfileUrl: 'http://127.0.0.1:1',
      jobDiscoveryUrl: 'http://127.0.0.1:1',
      applicationServiceUrl: 'http://127.0.0.1:1',
      notificationServiceUrl: notification.base,
      resumePreparationUrl: 'http://127.0.0.1:1',
      companyServiceUrl: 'http://127.0.0.1:1',
      frontendUrl: 'http://localhost:3000',
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await Promise.all([gateway.close(), notification.close()]);
  }
}

const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const forged = { 'X-User-Id': 'forged', 'X-User-Role': 'admin', 'X-Company-Id': 'co-evil-000000' };

test('seeker GET /mine is forwarded with verified identity replacing forged headers', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/notifications/mine`, { headers: as('seeker-token', forged) });
    assert.equal(res.status, 200);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'notification');
    assert.equal(echo.method, 'GET');
    assert.equal(echo.url, '/api/notifications/mine');
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
    assert.equal(echo.headers['x-company-id'], undefined);
  });
});

test('seeker POST /mine/read is forwarded', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/notifications/mine/read`, { method: 'POST', headers: as('seeker-token', forged) });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/api/notifications/mine/read');
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
  });
});

test('recruiters are refused with 403', async () => {
  await withGateway(async (base) => {
    const list = await fetch(`${base}/api/notifications/mine`, { headers: as('recruiter-token') });
    assert.equal(list.status, 403);
    assert.equal((await errorOf(list)).code, 'FORBIDDEN');
    const read = await fetch(`${base}/api/notifications/mine/read`, { method: 'POST', headers: as('recruiter-token') });
    assert.equal(read.status, 403);
  });
});

test('missing token is 401', async () => {
  await withGateway(async (base) => {
    assert.equal((await fetch(`${base}/api/notifications/mine`)).status, 401);
    assert.equal((await fetch(`${base}/api/notifications/mine/read`, { method: 'POST' })).status, 401);
  });
});

test('other notification paths and methods are a gateway 404', async () => {
  await withGateway(async (base) => {
    assert.equal((await fetch(`${base}/api/notifications`, { headers: as('seeker-token') })).status, 404);
    assert.equal((await fetch(`${base}/api/notifications/other`, { headers: as('seeker-token') })).status, 404);
    assert.equal((await fetch(`${base}/api/notifications/mine`, { method: 'POST', headers: as('seeker-token') })).status, 404);
    assert.equal((await fetch(`${base}/api/notifications/mine/read`, { headers: as('seeker-token') })).status, 404);
  });
});
