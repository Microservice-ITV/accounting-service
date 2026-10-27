import { Router } from 'express';
import { PayrollPolicyRepository } from '../payroll-policies/repositories/payrollPolicy.repository.js';
import { PayrollRunController } from './controllers/payrollRun.controller.js';
import { PayrollRunRepository } from './repositories/payrollRun.repository.js';
import { PayrollRunService } from './services/payrollRun.service.js';

const router = Router();
const controller = new PayrollRunController(
  new PayrollRunService(
    new PayrollRunRepository(),
    new PayrollPolicyRepository(),
  ),
);

router.get('/payroll-runs', controller.list.bind(controller));
router.get('/payroll-runs/:id', controller.getById.bind(controller));
router.post('/payroll-runs', controller.create.bind(controller));

router.post('/payroll-runs/:id/calculate', controller.calculate.bind(controller));
router.patch('/payroll-runs/:id/calculate', controller.calculate.bind(controller));

router.post('/payroll-runs/:id/submit', controller.submit.bind(controller));
router.patch('/payroll-runs/:id/submit', controller.submit.bind(controller));

router.post('/payroll-runs/:id/approve', controller.approve.bind(controller));
router.patch('/payroll-runs/:id/approve', controller.approve.bind(controller));

router.post('/payroll-runs/:id/reject', controller.reject.bind(controller));
router.patch('/payroll-runs/:id/reject', controller.reject.bind(controller));

router.post('/payroll-runs/:id/pay', controller.pay.bind(controller));
router.patch('/payroll-runs/:id/pay', controller.pay.bind(controller));
router.patch('/payroll-runs/:id/mark-paid', controller.pay.bind(controller));

router.post('/payroll-runs/:id/void', controller.voidRun.bind(controller));
router.patch('/payroll-runs/:id/void', controller.voidRun.bind(controller));

export default router;
