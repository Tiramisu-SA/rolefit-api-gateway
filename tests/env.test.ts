import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env';

const valid = {
  PORT: '8080',
  FRONTEND_URL: 'http://localhost:3000',
  CANDIDATE_PROFILE_SERVICE_URL: 'http://localhost:3001/',
  JOB_DISCOVERY_SERVICE_URL: 'http://localhost:3002',
  APPLICATION_SERVICE_URL: 'http://localhost:3004/',
  JOB_POSTING_GRPC_URL: 'localhost:50052',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
};

test('loadConfig reads every variable and strips trailing slashes', () => {
  const config = loadConfig(valid);
  assert.equal(config.port, 8080);
  assert.equal(config.candidateProfileUrl, 'http://localhost:3001');
  assert.equal(config.jobDiscoveryUrl, 'http://localhost:3002');
  assert.equal(config.applicationServiceUrl, 'http://localhost:3004');
  assert.equal(config.jobPostingGrpcUrl, 'localhost:50052');
});

test('loadConfig applies defaults for optional variables', () => {
  const { PORT, FRONTEND_URL, ...required } = valid;
  const config = loadConfig(required);
  assert.equal(config.port, 8080);
  assert.equal(config.frontendUrl, 'http://localhost:3000');
  assert.equal(config.nodeEnv, 'development');
});

test('loadConfig reports every missing or invalid variable at once', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc', CANDIDATE_PROFILE_SERVICE_URL: 'localhost:3001' }),
    (err: Error) =>
      [
        'PORT must be',
        'CANDIDATE_PROFILE_SERVICE_URL must start with http',
        'JOB_DISCOVERY_SERVICE_URL is required',
        'APPLICATION_SERVICE_URL is required',
        'JOB_POSTING_GRPC_URL is required',
        'SUPABASE_URL is required',
        'SUPABASE_PUBLISHABLE_KEY is required',
      ].every((part) => err.message.includes(part)),
  );
});

test('loadConfig no longer reads DEV_RECRUITER_COMPANY_ID', () => {
  const config = loadConfig({ ...valid, DEV_RECRUITER_COMPANY_ID: 'co-x' }) as unknown as Record<string, unknown>;
  assert.equal('recruiterCompanyId' in config, false);
});
