import { Router } from 'express';
import { PayrollPolicyController } from './controllers/payrollPolicy.controller.js';
import { PayrollPolicyRepository } from './repositories/payrollPolicy.repository.js';
import { PayrollPolicyService } from './services/payrollPolicy.service.js';

const router = Router();
const controller = new PayrollPolicyController(
  new PayrollPolicyService(new PayrollPolicyRepository()),
);

router.get('/payroll-policies', controller.list.bind(controller));
router.get('/payroll-policies/active', controller.getActive.bind(controller));
router.get('/payroll-policies/:id', controller.getById.bind(controller));
router.post('/payroll-policies', controller.create.bind(controller));
router.put('/payroll-policies/:id', controller.update.bind(controller));
router.patch('/payroll-policies/:id', controller.update.bind(controller));
router.delete('/payroll-policies/:id', controller.delete.bind(controller));

export default router;
