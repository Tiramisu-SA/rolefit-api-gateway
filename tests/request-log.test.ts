import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { createApp, type AppDependencies } from '../src/app';
import { grpcErrorToAppError } from '../src/grpc/grpc-errors';
import { logger } from '../src/utils/logger';
import { withCapturedLogs } from './capture-logs';
import { echoService, fakeVerifier, listen } from './helpers';

const auth = { Authorization: 'Bearer seeker-token' };
const errorMessage = (line: Record<string, unknown>) => (line.error as { message?: string } | undefined)?.message;

async function withGateway(fn: (base: string) => Promise<void>, overrides: Partial<AppDependencies> = {}) {
  const echo = await listen(echoService('echo'));
  const gateway = await listen(
    createApp({
      verifyClaims: fakeVerifier,
      jobPosting: (async () => ({ jobs: [], total: 0, page: 1, limit: 20 })) as unknown as AppDependencies['jobPosting'],
      candidateProfileUrl: echo.base,
      jobDiscoveryUrl: echo.base,
      applicationServiceUrl: echo.base,
      resumePreparationUrl: echo.base,
      companyServiceUrl: 'http://127.0.0.1:1',
      frontendUrl: 'http://localhost:3000',
      ...overrides,
    }),
  );
  try {
    await fn(gateway.base);
  } finally {
    await gateway.close();
    await echo.close();
  }
}

test('a request logs one JSON line with its id, method, path without query, status and duration', async () => {
  await withCapturedLogs(async (logs) => {
    await withGateway(async (base) => {
      const res = await fetch(`${base}/api/candidates/profiles/me?query=private`, { headers: { ...auth, 'X-Request-Id': 'req-abc_1.2' } });
      assert.equal(res.status, 200);

      const line = await logs.waitFor((l) => l.requestId === 'req-abc_1.2');
      assert.equal(line.service, 'api-gateway');
      assert.equal(line.level, 'info');
      assert.equal(line.method, 'GET');
      assert.equal(line.path, '/api/candidates/profiles/me');
      assert.equal(line.status, 200);
      assert.equal(typeof line.durationMs, 'number');
    });
  });
});

test('health checks are not logged, so polling does not bury real requests', async () => {
  await withCapturedLogs(async (logs) => {
    await withGateway(async (base) => {
      await fetch(`${base}/health`);
      await fetch(`${base}/api/candidates/profiles/me`, { headers: auth });
      await logs.waitFor((l) => l.path === '/api/candidates/profiles/me');
      assert.equal(logs.lines().filter((l) => l.path === '/health').length, 0);
    });
  });
});

test('an unreachable service is logged with the request id and the service name', async () => {
  await withCapturedLogs(async (logs) => {
    await withGateway(
      async (base) => {
        const res = await fetch(`${base}/api/candidates/profiles/me`, { headers: { ...auth, 'X-Request-Id': 'req-down' } });
        assert.equal(res.status, 503);
        const line = await logs.waitFor((l) => l.requestId === 'req-down' && l.level === 'error');
        assert.equal(line.upstream, 'candidate profile');
      },
      { candidateProfileUrl: 'http://127.0.0.1:1' },
    );
  });
});

test('an unexpected error is logged with the request id', async () => {
  await withCapturedLogs(async (logs) => {
    await withGateway(
      async (base) => {
        const res = await fetch(`${base}/api/jobs`, { headers: { ...auth, 'X-Request-Id': 'req-boom' } });
        assert.equal(res.status, 500);
        assert.equal((await logs.waitFor((l) => errorMessage(l) === 'boom')).requestId, 'req-boom');
      },
      {
        jobPosting: (async () => {
          throw new Error('boom');
        }) as unknown as AppDependencies['jobPosting'],
      },
    );
  });
});

test('a token verifier failure, logged deep in the auth code, still carries the request id', async () => {
  await withCapturedLogs(async (logs) => {
    await withGateway(
      async (base) => {
        await fetch(`${base}/api/candidates/profiles/me`, { headers: { ...auth, 'X-Request-Id': 'req-verifier' } });
        const line = await logs.waitFor((l) => l.level === 'warn');
        assert.equal(line.requestId, 'req-verifier');
      },
      {
        verifyClaims: async () => {
          throw new Error('verifier down');
        },
      },
    );
  });
});

test('an unexpected gRPC status is logged with the request id', async () => {
  await withCapturedLogs(async (logs) => {
    grpcErrorToAppError(Object.assign(new Error('x'), { code: grpc.status.DATA_LOSS, details: 'lost', metadata: new grpc.Metadata() }), 'req-grpc');
    const line = await logs.waitFor((l) => l.level === 'error');
    assert.equal(line.requestId, 'req-grpc');
    assert.equal(line.code, grpc.status.DATA_LOSS);
  });
});

test('an unavailable Job Posting Service is logged with the request id and its name', async () => {
  await withCapturedLogs(async (logs) => {
    const error = grpcErrorToAppError(Object.assign(new Error('x'), { code: grpc.status.UNAVAILABLE, details: 'down', metadata: new grpc.Metadata() }), 'req-jobs-down');
    assert.equal(error.httpStatus, 503);
    const line = await logs.waitFor((l) => l.level === 'error');
    assert.equal(line.requestId, 'req-jobs-down');
    assert.equal(line.upstream, 'job posting');
  });
});

test('the logger writes an Error as JSON and survives values JSON cannot represent', async () => {
  await withCapturedLogs(async (logs) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error('It failed', new TypeError('bad input'));
    logger.error('Circular detail', circular);
    const error = (await logs.waitFor((l) => l.message === 'It failed')).error as { name: string; message: string };
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, 'bad input');
    await logs.waitFor((l) => l.message === 'Circular detail');
  });
});
