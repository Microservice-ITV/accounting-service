import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  adjustmentSchema,
  bonusAwardSyncSchema,
  itemQuerySchema,
  paymentQuerySchema,
  paymentSchema,
  paymentStatusSchema,
  payslipQuerySchema,
  toAdjustmentInput,
  toBonusAwardSyncInput,
  toPaymentRecordInput,
} from '../dto/payrollRecord.dto.js';
import type { IPayrollRecordService } from '../interfaces/payrollRecord.service.interface.js';
import {
  payrollPaginated,
  payrollResponse,
  sendPayrollError,
  sendPayrollNotFound,
} from '../../payroll-shared/payrollSerialization.js';

const sendValidationError = (res: Response, error: unknown, fallback: string) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ message: error.issues[0]?.message ?? fallback });
  }
  return sendPayrollError(res, error, fallback);
};

const pathParam = (value: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

export class PayrollRecordController {
  constructor(private readonly payrollRecordService: IPayrollRecordService) {}

  async listMyPayslips(req: Request, res: Response) {
    try {
      const query = payslipQuerySchema.parse(req.query);
      const employeeId =
        req.header('x-employee-id') ??
        (typeof req.query.employee_id === 'string' ? req.query.employee_id : undefined);

      const { payslips, total } = await this.payrollRecordService.listPayslips({
        employeeId,
        status: query.status,
        page: query.page,
        perPage: query.per_page,
      });

      return res.json(
        payrollResponse({
          payslips: payrollPaginated(payslips, total, query.page, query.per_page),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Failed to fetch payslips');
    }
  }

  async listPayslips(req: Request, res: Response) {
    try {
      const query = payslipQuerySchema.parse(req.query);
      const { payslips, total } = await this.payrollRecordService.listPayslips({
        employeeId: query.employee_id,
        payrollRunId: query.payroll_run_id,
        status: query.status,
        page: query.page,
        perPage: query.per_page,
      });

      return res.json(
        payrollResponse({
          payslips: payrollPaginated(payslips, total, query.page, query.per_page),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Failed to fetch payslips');
    }
  }

  async getPayslip(req: Request, res: Response) {
    try {
      const payslip = await this.payrollRecordService.getPayslipById(
        pathParam(req.params.id),
      );
      return payslip
        ? res.json(payrollResponse({ payslip }))
        : sendPayrollNotFound(res, 'Payslip not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to fetch payslip');
    }
  }

  async issuePayslip(req: Request, res: Response) {
    try {
      const payslip = await this.payrollRecordService.issuePayslip(
        pathParam(req.params.id),
      );
      return payslip
        ? res.json(payrollResponse({ payslip }))
        : sendPayrollNotFound(res, 'Payslip not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to issue payslip');
    }
  }

  async revokePayslip(req: Request, res: Response) {
    try {
      const payslip = await this.payrollRecordService.revokePayslip(
        pathParam(req.params.id),
      );
      return payslip
        ? res.json(payrollResponse({ payslip }))
        : sendPayrollNotFound(res, 'Payslip not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to revoke payslip');
    }
  }

  async listPaymentRecords(req: Request, res: Response) {
    try {
      const query = paymentQuerySchema.parse(req.query);
      const { paymentRecords, total } = await this.payrollRecordService.listPaymentRecords({
        payrollRunId: query.payroll_run_id,
        employeeId: query.employee_id,
        status: query.status,
        method: query.method,
        page: query.page,
        perPage: query.per_page,
      });

      return res.json(
        payrollResponse({
          payment_records: payrollPaginated(
            paymentRecords,
            total,
            query.page,
            query.per_page,
          ),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Failed to fetch payment records');
    }
  }

  async updatePaymentStatus(req: Request, res: Response) {
    try {
      const body = paymentStatusSchema.parse(req.body);
      const payment = await this.payrollRecordService.updatePaymentStatus(
        pathParam(req.params.id),
        body.status,
      );
      return payment
        ? res.json(payrollResponse({ payment_record: payment }))
        : sendPayrollNotFound(res, 'Payment record not found');
    } catch (error) {
      return sendValidationError(res, error, 'Failed to update payment status');
    }
  }

  async listRunItems(req: Request, res: Response) {
    try {
      const query = itemQuerySchema.parse(req.query);
      const { items, total } = await this.payrollRecordService.listRunItems(
        pathParam(req.params.id),
        query.page,
        query.per_page,
      );
      return res.json(
        payrollResponse({
          payroll_items: payrollPaginated(items, total, query.page, query.per_page),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Failed to fetch payroll items');
    }
  }

  async listRunAuditLogs(req: Request, res: Response) {
    try {
      const logs = await this.payrollRecordService.listRunAuditLogs(
        pathParam(req.params.id),
      );
      return res.json(payrollResponse({ payroll_audit_logs: logs }));
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to fetch payroll audit logs');
    }
  }

  async generatePayslips(req: Request, res: Response) {
    try {
      const payslips = await this.payrollRecordService.generatePayslipsForRun(
        pathParam(req.params.id),
      );
      return res.json(payrollResponse({ payslips }));
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to generate payslips');
    }
  }

  async listRunPayments(req: Request, res: Response) {
    try {
      const payments = await this.payrollRecordService.listRunPayments(
        pathParam(req.params.id),
      );
      return res.json(payrollResponse({ payment_records: payments }));
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to fetch payments');
    }
  }

  async recordPayment(req: Request, res: Response) {
    try {
      const body = paymentSchema.parse(req.body);
      const payment = await this.payrollRecordService.recordPayment(
        pathParam(req.params.id),
        toPaymentRecordInput(body),
      );
      return res.status(201).json(payrollResponse({ payment_record: payment }));
    } catch (error) {
      return sendValidationError(res, error, 'Failed to record payment');
    }
  }

  async syncBonusAward(req: Request, res: Response) {
    try {
      const body = bonusAwardSyncSchema.parse(req.body);
      const item = await this.payrollRecordService.syncBonusAward(
        pathParam(req.params.id),
        toBonusAwardSyncInput(body),
      );
      return res.status(201).json(payrollResponse({ payroll_item: item }));
    } catch (error) {
      return sendValidationError(res, error, 'Failed to sync bonus award');
    }
  }

  async addAdjustment(req: Request, res: Response) {
    try {
      const body = adjustmentSchema.parse(req.body);
      const item = await this.payrollRecordService.addAdjustment(
        pathParam(req.params.runId),
        pathParam(req.params.itemId),
        toAdjustmentInput(body),
      );
      return res.status(201).json(payrollResponse({ payroll_item: item }));
    } catch (error) {
      return sendValidationError(res, error, 'Failed to add adjustment');
    }
  }

  async removeAdjustment(req: Request, res: Response) {
    try {
      const item = await this.payrollRecordService.removeAdjustment(
        pathParam(req.params.runId),
        pathParam(req.params.itemId),
        pathParam(req.params.lineId),
      );
      return res.json(payrollResponse({ payroll_item: item }));
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to remove adjustment');
    }
  }
}
