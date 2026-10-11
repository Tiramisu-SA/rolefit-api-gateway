import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authenticate, requireCompany, requireRecruiter } from '../src/middleware/auth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import { COMPANY_ID, errorOf, fakeVerifier, jwtWithExp, listen, RECRUITER as RECRUITER_ID, SEEKER } from './helpers';

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
  a.get('/recruiter-company', requireRecruiter, requireCompany, (_req, res) => {
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

test('company claims from app_metadata are copied into req.user', async () => {
  const { status, body } = await call('/echo', { Authorization: 'Bearer recruiter-token' });
  assert.equal(status, 200);
  assert.deepEqual(body.user, { id: RECRUITER_ID, role: 'recruiter', companyId: COMPANY_ID, companyName: 'Acme Corp' });
});

test('requireCompany refuses a recruiter token without company_id with 403 NO_COMPANY', async () => {
  const { status, body } = await call('/recruiter-company', { Authorization: 'Bearer recruiter-no-company-token' });
  assert.equal(status, 403);
  assert.deepEqual(body.error, { code: 'NO_COMPANY', message: 'This recruiter account has no company yet. Sign out and sign in again.' });
  const ok = await call('/recruiter-company', { Authorization: 'Bearer recruiter-token' });
  assert.equal(ok.status, 200);
});
