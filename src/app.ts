import express, { type Express } from 'express';
import type { ClaimsVerifier } from './auth/supabase';
import type { JobPostingCaller } from './grpc/job-posting.client';
import { authenticate } from './middleware/auth.middleware';
import { cors } from './middleware/cors.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/logger.middleware';
import { createServiceProxy } from './proxy/service-proxy';
import { createApplicationRoutes } from './routes/application.routes';
import { createJobRoutes } from './routes/job.routes';

export interface AppDependencies {
  /** Verifies Supabase access tokens. */
  verifyClaims: ClaimsVerifier;
  /** Calls the Job Posting Service over gRPC. */
  jobPosting: JobPostingCaller;
  candidateProfileUrl: string;
  jobDiscoveryUrl: string;
  /** Application Service REST base URL (still in development). */
  applicationServiceUrl: string;
  /** The web frontend origin allowed by CORS, e.g. http://localhost:3000. */
  frontendUrl: string;
}

/**
 * Builds the gateway app. Does not listen on a port, which keeps it easy to test.
 * No global body parser: proxied requests are streamed to the services untouched.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(cors(deps.frontendUrl));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'rolefit-api-gateway' });
  });

  app.use('/api', authenticate(deps.verifyClaims));
  app.use('/api/candidates', createServiceProxy(deps.candidateProfileUrl, 'candidate profile'));
  app.use('/api/discovery', createServiceProxy(deps.jobDiscoveryUrl, 'job discovery'));
  app.use('/api/jobs', createJobRoutes(deps.jobPosting));
  app.use('/api/applications', createApplicationRoutes(deps.applicationServiceUrl));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
