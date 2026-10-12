import { Router } from 'express';
import { requireCompany, requireSeekerOrCompanyRecruiter, requireRecruiter, requireSeeker } from '../middleware/auth.middleware';
import { createServiceProxy } from '../proxy/service-proxy';

/**
 * The five Application Service endpoints, mounted at /api/applications and
 * forwarded to the same path upstream. Other paths under /api/applications
 * fall through to the gateway's 404. The service repeats every role and
 * ownership check.
 */
export function createApplicationRoutes(applicationServiceUrl: string): Router {
  const router = Router();
  const proxy = createServiceProxy(applicationServiceUrl, 'application', '/api/applications');

  router.post('/', requireSeeker, proxy);
  router.get('/mine', requireSeeker, proxy);
  router.get('/', requireRecruiter, requireCompany, proxy);
  router.get('/:applicationId', requireSeekerOrCompanyRecruiter, proxy);
  router.patch('/:applicationId/status', requireRecruiter, requireCompany, proxy);

  return router;
}
