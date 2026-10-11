import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { JobMessage, JobPostingCaller, RecruiterCaller } from '../src/grpc/job-posting.client';
import { errorHandler } from '../src/middleware/error.middleware';
import { createJobRoutes } from '../src/routes/job.routes';
import { AppError } from '../src/utils/errors';
import { COMPANY_ID, errorOf, listen, RECRUITER, SEEKER } from './helpers';

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

type Who = 'seeker' | 'recruiter' | 'recruiter-no-company';

/** Mounts the router behind a stand-in for `authenticate`. */
async function withJobs(who: Who, jobPosting: JobPostingCaller, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => {
    req.user =
      who === 'seeker'
        ? { id: SEEKER, role: 'seeker' }
        : who === 'recruiter'
          ? { id: RECRUITER, role: 'recruiter', companyId: COMPANY_ID, companyName: 'Acme Corp' }
          : { id: RECRUITER, role: 'recruiter' };
    next();
  });
  app.use('/api/jobs', createJobRoutes(jobPosting));
  app.use(errorHandler);
  const { base, close } = await listen(app);
  try {
    await fn(base);
  } finally {
    await close();
  }
}

const recruiterCaller = { userId: RECRUITER, companyId: COMPANY_ID };

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
    { method: 'ListJobs', request: { company_id: COMPANY_ID, status: 'JOB_STATUS_DRAFT', query: 'dev', limit: 100 }, caller: recruiterCaller },
    { method: 'ListJobs', request: { company_id: COMPANY_ID, status: 'JOB_STATUS_UNSPECIFIED', query: '', limit: 100 }, caller: recruiterCaller },
  ]);
});

test('GET /api/jobs/mine/company returns the company from the token without an RPC', async () => {
  const { call, calls } = recording();
  await withJobs('recruiter', call, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/jobs/mine/company`)).json(), { companyId: COMPANY_ID, companyName: 'Acme Corp' });
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
  assert.ok(calls.every((c) => c.caller?.userId === RECRUITER && c.caller.companyId === COMPANY_ID));
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

test('a recruiter without a company gets 403 NO_COMPANY and no RPC is made', async () => {
  const { call, calls } = recording();
  await withJobs('recruiter-no-company', call, async (base) => {
    const res = await fetch(`${base}/api/jobs/mine`);
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'NO_COMPANY');
  });
  assert.equal(calls.length, 0);
});
