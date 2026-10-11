import { Router } from 'express';
import { requireCompany, requireCompanyIfRecruiter, requireRecruiter, requireSeeker } from '../middleware/auth.middleware';
import { createServiceProxy } from '../proxy/service-proxy';

/**
 * The four Application Service endpoints, mounted at /api/applications and
 * forwarded to the same path upstream. Anything else under /api/applications
 * (for example submitting, which the service doesn't offer yet) falls through
 * to the gateway's 404. The service repeats every role and ownership check.
 */
export function createApplicationRoutes(applicationServiceUrl: string): Router {
  const router = Router();
  const proxy = createServiceProxy(applicationServiceUrl, 'application', '/api/applications');

  router.get('/mine', requireSeeker, proxy);
  router.get('/', requireRecruiter, requireCompany, proxy);
  router.get('/:applicationId', requireCompanyIfRecruiter, proxy);
  router.patch('/:applicationId/status', requireRecruiter, requireCompany, proxy);

  return router;
}
