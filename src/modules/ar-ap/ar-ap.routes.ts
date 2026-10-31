import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireExpenseAuth } from '../../middleware/auth.js';
import { ArApController } from './controllers/ar-ap.controller.js';
import { ArApRepository } from './repositories/ar-ap.repository.js';
import { ArApService } from './services/ar-ap.service.js';

export function createArApRouter(
  service: ArApService = new ArApService(new ArApRepository()),
  authMiddleware: RequestHandler = requireExpenseAuth,
) {
  const router = Router();
  const controller = new ArApController(service);

  router.get('/reports/ar-ap', authMiddleware, controller.getSummary.bind(controller));
  router.get('/reports/ar-ap/transactions', authMiddleware, controller.listTransactions.bind(controller));
  router.get(
    '/reports/ar-ap/transactions/:referenceType/:referenceId',
    authMiddleware,
    controller.getTransaction.bind(controller),
  );
  router.get('/reports/ar-ap/aging', authMiddleware, controller.getAging.bind(controller));
  return router;
}

export default createArApRouter();