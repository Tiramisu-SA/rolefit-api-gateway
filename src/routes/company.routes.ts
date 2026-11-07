import { Router } from 'express';
import { requireCompany, requireRecruiter } from '../middleware/auth.middleware';
import { createServiceProxy } from '../proxy/service-proxy';

/**
 * Company Service endpoints, forwarded to the same path upstream
 * (/api/companies/*, /api/recruiters/*). Other paths fall through to the
 * gateway's 404. Reading a company by id is open to any signed-in user (the
 * app already mounts these behind `authenticate`); the service repeats every
 * role check.
 */
export function createCompanyRoutes(companyServiceUrl: string): Router {
  const router = Router();
  const companies = createServiceProxy(companyServiceUrl, 'company', '/api/companies');

  router.get('/me', requireRecruiter, requireCompany, companies);
  router.put('/me', requireRecruiter, requireCompany, companies);
  router.get('/:companyId', companies);

  return router;
}

export function createRecruiterRoutes(companyServiceUrl: string): Router {
  const router = Router();
  const recruiters = createServiceProxy(companyServiceUrl, 'company', '/api/recruiters');

  router.get('/me', requireRecruiter, requireCompany, recruiters);
  router.put('/me', requireRecruiter, requireCompany, recruiters);

  return router;
}
