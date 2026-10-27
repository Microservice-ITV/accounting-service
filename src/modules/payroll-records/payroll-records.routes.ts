import { Router } from 'express';
import { PayrollRecordController } from './controllers/payrollRecord.controller.js';
import { EmployeeDirectoryRepository } from './repositories/employeeDirectory.repository.js';
import { PayrollRecordRepository } from './repositories/payrollRecord.repository.js';
import { PayrollRecordService } from './services/payrollRecord.service.js';

const router = Router();
const controller = new PayrollRecordController(
  new PayrollRecordService(
    new PayrollRecordRepository(),
    new EmployeeDirectoryRepository(),
  ),
);

router.get('/payslips/me', controller.listMyPayslips.bind(controller));
router.get('/payslips', controller.listPayslips.bind(controller));
router.get('/payslips/:id', controller.getPayslip.bind(controller));
router.post('/payslips/:id/issue', controller.issuePayslip.bind(controller));
router.post('/payslips/:id/revoke', controller.revokePayslip.bind(controller));

router.get('/payment-records', controller.listPaymentRecords.bind(controller));
router.patch('/payment-records/:id/status', controller.updatePaymentStatus.bind(controller));
router.put('/payment-records/:id/status', controller.updatePaymentStatus.bind(controller));

router.get('/payroll-runs/:id/items', controller.listRunItems.bind(controller));
router.get('/payroll-runs/:id/audit-logs', controller.listRunAuditLogs.bind(controller));
router.post('/payroll-runs/:id/payslips', controller.generatePayslips.bind(controller));
router.get('/payroll-runs/:id/payments', controller.listRunPayments.bind(controller));
router.post('/payroll-runs/:id/payments', controller.recordPayment.bind(controller));
router.post('/payroll-runs/:id/bonus-awards', controller.syncBonusAward.bind(controller));
router.post(
  '/payroll-runs/:runId/items/:itemId/lines',
  controller.addAdjustment.bind(controller),
);
router.delete(
  '/payroll-runs/:runId/items/:itemId/lines/:lineId',
  controller.removeAdjustment.bind(controller),
);

export default router;
