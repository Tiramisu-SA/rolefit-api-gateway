import { Router } from 'express';
import { requireSeeker } from '../middleware/auth.middleware';
import { createServiceProxy } from '../proxy/service-proxy';

/**
 * The two Notification Service endpoints, mounted at /api/notifications and
 * forwarded to the same path upstream. Other paths fall through to the
 * gateway's 404. The service scopes every query to the verified user.
 */
export function createNotificationRoutes(notificationServiceUrl: string): Router {
  const router = Router();
  const proxy = createServiceProxy(notificationServiceUrl, 'notification', '/api/notifications');

  router.get('/mine', requireSeeker, proxy);
  router.post('/mine/read', requireSeeker, proxy);

  return router;
}
