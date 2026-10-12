import { createApp } from './app';
import { createClaimsVerifier } from './auth/supabase';
import { loadConfig } from './config/env';
import { createJobPostingCaller } from './grpc/job-posting.client';
import { logger } from './utils/logger';

const config = loadConfig();

const app = createApp({
  verifyClaims: createClaimsVerifier(config.supabaseUrl, config.supabasePublishableKey),
  jobPosting: createJobPostingCaller(config.jobPostingGrpcUrl),
  candidateProfileUrl: config.candidateProfileUrl,
  jobDiscoveryUrl: config.jobDiscoveryUrl,
  applicationServiceUrl: config.applicationServiceUrl,
  resumePreparationUrl: config.resumePreparationUrl,
  frontendUrl: config.frontendUrl,
});

app.listen(config.port, () => {
  logger.info(`API Gateway listening on http://localhost:${config.port}`);
  logger.info(`  /api/candidates/* → ${config.candidateProfileUrl}/api/*`);
  logger.info(`  /api/discovery/*  → ${config.jobDiscoveryUrl}/api/*`);
  logger.info(`  /api/applications/* → ${config.applicationServiceUrl}/api/applications/*`);
  logger.info(`  /api/resumes/*      → ${config.resumePreparationUrl}/api/*`);
  logger.info(`  /api/jobs/*       → gRPC ${config.jobPostingGrpcUrl}`);
});
