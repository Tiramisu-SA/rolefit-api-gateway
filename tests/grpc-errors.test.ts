import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '@grpc/grpc-js';
import { grpcErrorToAppError } from '../src/grpc/grpc-errors';

function grpcError(code: number, details: string, metadata: Record<string, string> = {}) {
  return { code, details, metadata: { get: (key: string) => (key in metadata ? [metadata[key]] : []) } };
}

test('maps client-error statuses to HTTP and keeps the service message', () => {
  const cases: [number, number, string][] = [
    [status.NOT_FOUND, 404, 'NOT_FOUND'],
    [status.FAILED_PRECONDITION, 409, 'INVALID_STATE'],
    [status.PERMISSION_DENIED, 403, 'FORBIDDEN'],
    [status.UNAUTHENTICATED, 401, 'UNAUTHENTICATED'],
  ];
  for (const [code, httpStatus, appCode] of cases) {
    const err = grpcErrorToAppError(grpcError(code, 'from service'));
    assert.equal(err.httpStatus, httpStatus);
    assert.equal(err.code, appCode);
    assert.equal(err.message, 'from service');
  }
});

test('INVALID_ARGUMENT reads field errors from the x-validation-errors trailer', () => {
  const err = grpcErrorToAppError(
    grpcError(status.INVALID_ARGUMENT, 'title: Is required', {
      'x-validation-errors': JSON.stringify([{ field: 'title', message: 'Is required' }]),
    }),
  );
  assert.equal(err.httpStatus, 400);
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.deepEqual(err.details, [{ field: 'title', message: 'Is required' }]);
});

test('unreadable x-validation-errors is ignored', () => {
  const err = grpcErrorToAppError(grpcError(status.INVALID_ARGUMENT, 'bad', { 'x-validation-errors': '{not json' }));
  assert.equal(err.details, undefined);
});

test('UNAVAILABLE and DEADLINE_EXCEEDED become 503 SERVICE_UNAVAILABLE', () => {
  for (const code of [status.UNAVAILABLE, status.DEADLINE_EXCEEDED]) {
    const err = grpcErrorToAppError(grpcError(code, 'connect ECONNREFUSED 127.0.0.1:50052'));
    assert.equal(err.httpStatus, 503);
    assert.equal(err.code, 'SERVICE_UNAVAILABLE');
    assert.equal(err.message, 'The job posting service is unavailable. Please try again.');
  }
});

test('other statuses become a generic 500 that hides details', () => {
  const err = grpcErrorToAppError(grpcError(status.INTERNAL, 'stack trace...'));
  assert.equal(err.httpStatus, 500);
  assert.equal(err.code, 'INTERNAL_ERROR');
  assert.equal(err.message, 'Something went wrong with the job service. Please try again.');
});
