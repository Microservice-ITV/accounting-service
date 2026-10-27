import { Router } from 'express';
import { requireDeliveryCompanyConfigurationAccess, requireExpenseAuth } from '../../middleware/auth.js';
import { DeliveryCompanyFeeController } from './controllers/delivery-company-fee.controller.js';
import { deliveryCompanyFeeService } from './delivery-company-fee.module.js';

const router = Router();
const controller = new DeliveryCompanyFeeController(deliveryCompanyFeeService);

router.get(
  '/delivery-company-configurations/shops/:shopId/active',
  requireDeliveryCompanyConfigurationAccess,
  controller.listActiveConfigurations,
);

router.get(
  '/delivery-company-configurations/shops/:shopId/checkout',
  controller.listActiveConfigurations,
);

router.get(
  '/delivery-company-configurations/shops/:shopId/companies/:deliveryCompanyId',
  requireDeliveryCompanyConfigurationAccess,
  controller.validateConfiguration,
);

router.get('/delivery-company-fees', requireExpenseAuth, controller.list);
router.get('/delivery-company-fees/:id', requireExpenseAuth, controller.get);
router.post('/delivery-company-fees', requireExpenseAuth, controller.create);
router.patch('/delivery-company-fees/:id', requireExpenseAuth, controller.update);
router.patch('/delivery-company-fees/:id/status', requireExpenseAuth, controller.setActive);

export default router;
