import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireExpenseAuth } from '../../middleware/auth.js';
import { InvoiceProjectionController } from './controllers/invoice-projection.controller.js';
import { InvoiceProjectionRepository } from './repositories/invoice-projection.repository.js';
import { InvoiceProjectionService } from './services/invoice-projection.service.js';

export function createInvoiceProjectionRouter(
  service: InvoiceProjectionService = new InvoiceProjectionService(new InvoiceProjectionRepository()),
  authMiddleware: RequestHandler = requireExpenseAuth,
) {
  const router = Router();
  const controller = new InvoiceProjectionController(service);
  router.get('/reports/ar-ap/invoices', authMiddleware, controller.list.bind(controller));
  return router;
}

export default createInvoiceProjectionRouter();
