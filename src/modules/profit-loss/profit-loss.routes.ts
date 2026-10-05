import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireExpenseAuth } from '../../middleware/auth.js';
import { ProfitLossController } from './controllers/profit-loss.controller.js';
import { ProfitLossRepository } from './repositories/profit-loss.repository.js';
import type { IProfitLossService } from './interfaces/profit-loss.service.interface.js';
import { ProfitLossService } from './services/profit-loss.service.js';

export function createProfitLossRouter(
  service: IProfitLossService = new ProfitLossService(new ProfitLossRepository()),
  authMiddleware: RequestHandler = requireExpenseAuth,
) {
  const router = Router();
  const controller = new ProfitLossController(service);
  router.get('/reports/profit-loss', authMiddleware, controller.getProfitLoss.bind(controller));
  return router;
}

export default createProfitLossRouter();
