import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createJobPostingCaller } from '../src/grpc/job-posting.client';
import { AppError } from '../src/utils/errors';

const PROTO = path.join(__dirname, '..', 'proto', 'job-posting.proto');

async function startFakeJobPosting(impl: grpc.UntypedServiceImplementation) {
  const definition = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    rolefit: { jobposting: { v1: { JobPostingService: grpc.ServiceClientConstructor } } };
  };
  const server = new grpc.Server();
  server.addService(loaded.rolefit.jobposting.v1.JobPostingService.service, impl);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return { url: `127.0.0.1:${port}`, stop: () => server.forceShutdown() };
}

const echoGetJob: grpc.UntypedServiceImplementation = {
  GetJob: (call: grpc.ServerUnaryCall<{ job_id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    callback(null, {
      job: {
        id: call.request.job_id,
        recruiter_id: String(call.metadata.get('x-user-id')[0] ?? ''),
        company_id: String(call.metadata.get('x-company-id')[0] ?? ''),
        title: String(call.metadata.get('x-request-id')[0] ?? ''),
      },
    });
  },
};

test('sends the request and recruiter metadata, returns the proto message as a plain object', async () => {
  const fake = await startFakeJobPosting(echoGetJob);
  try {
    const call = createJobPostingCaller(fake.url);
    const res = await call<{ job: Record<string, unknown> }>('GetJob', { job_id: 'job_1' }, { userId: 'u1', companyId: 'co-x' });
    assert.equal(res.job.id, 'job_1');
    assert.equal(res.job.recruiter_id, 'u1');
    assert.equal(res.job.company_id, 'co-x');
    // defaults: true + enums: String → unset enum comes back as its name
    assert.equal(res.job.status, 'JOB_STATUS_UNSPECIFIED');
  } finally {
    fake.stop();
  }
});

test('sends the request id as x-request-id metadata', async () => {
  const fake = await startFakeJobPosting(echoGetJob);
  try {
    const res = await createJobPostingCaller(fake.url)<{ job: Record<string, unknown> }>('GetJob', { job_id: 'job_1' }, undefined, 'req-42');
    assert.equal(res.job.title, 'req-42');
    assert.equal(res.job.recruiter_id, '');
  } finally {
    fake.stop();
  }
});

test('sends no identity metadata when no caller is given', async () => {
  const fake = await startFakeJobPosting(echoGetJob);
  try {
    const res = await createJobPostingCaller(fake.url)<{ job: Record<string, unknown> }>('GetJob', { job_id: 'job_1' });
    assert.equal(res.job.recruiter_id, '');
    assert.equal(res.job.company_id, '');
  } finally {
    fake.stop();
  }
});

test('a gRPC error with a validation trailer becomes a 400 AppError with details', async () => {
  const fake = await startFakeJobPosting({
    CreateJob: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
      const metadata = new grpc.Metadata();
      metadata.set('x-validation-errors', JSON.stringify([{ field: 'title', message: 'Is required' }]));
      callback({ code: grpc.status.INVALID_ARGUMENT, details: 'title: Is required', metadata });
    },
  });
  try {
    await assert.rejects(createJobPostingCaller(fake.url)('CreateJob', { job: {} }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.httpStatus, 400);
      assert.deepEqual(err.details, [{ field: 'title', message: 'Is required' }]);
      return true;
    });
  } finally {
    fake.stop();
  }
});

test('an unreachable service rejects with 503 SERVICE_UNAVAILABLE', async () => {
  const call = createJobPostingCaller('127.0.0.1:1', 2000);
  await assert.rejects(call('GetJob', { job_id: 'job_1' }), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.httpStatus, 503);
    assert.equal(err.code, 'SERVICE_UNAVAILABLE');
    return true;
  });
});
