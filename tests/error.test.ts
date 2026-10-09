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
