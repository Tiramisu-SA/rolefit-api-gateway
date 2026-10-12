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
  body: string | null;
}

async function withGateway(fn: (base: string) => Promise<void>, resumePreparationUrl?: string) {
  const resume = await listen(echoService('resume-preparation'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: noJobs,
      candidateProfileUrl: 'http://127.0.0.1:1',
      jobDiscoveryUrl: 'http://127.0.0.1:1',
      applicationServiceUrl: 'http://127.0.0.1:1',
      resumePreparationUrl: resumePreparationUrl ?? resume.base,
      frontendUrl: 'http://localhost:3000',
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await Promise.all([gateway.close(), resume.close()]);
  }
}

const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

test('seeker POST generate is forwarded to /api/drafts with token and verified identity', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/resumes/drafts/job_1/generate`, { method: 'POST', headers: as('seeker-token') });
    assert.equal(res.status, 201);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.service, 'resume-preparation');
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/api/drafts/job_1/generate');
    assert.equal(echo.headers['authorization'], 'Bearer seeker-token');
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
  });
});

test('seeker PUT sections keeps the JSON body', async () => {
  await withGateway(async (base) => {
    const payload = { sections: [{ id: 's1', content: 'Hello' }] };
    const res = await fetch(`${base}/api/resumes/drafts/job_1/sections`, {
      method: 'PUT',
      headers: as('seeker-token', { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'PUT');
    assert.equal(echo.url, '/api/drafts/job_1/sections');
    assert.deepEqual(JSON.parse(echo.body ?? ''), payload);
  });
});

test('recruiters are rejected with 403 FORBIDDEN', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/resumes/drafts/job_1`, { headers: as('recruiter-token') });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
});

test('requests without a token get 401 MISSING_TOKEN', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/resumes/drafts/job_1`);
    assert.equal(res.status, 401);
    assert.equal((await errorOf(res)).code, 'MISSING_TOKEN');
  });
});

test('an unreachable service gives 503 SERVICE_UNAVAILABLE', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/resumes/drafts/job_1`, { headers: as('seeker-token') });
    assert.equal(res.status, 503);
    const err = await errorOf(res);
    assert.equal(err.code, 'SERVICE_UNAVAILABLE');
    assert.equal(err.message, 'The resume preparation service is unavailable. Please try again.');
  }, 'http://127.0.0.1:1');
});
