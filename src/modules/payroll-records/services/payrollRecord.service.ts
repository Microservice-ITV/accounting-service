import type { PaymentStatus, Prisma } from '@prisma/client';
import type {
  AdjustmentInput,
  BonusAwardSyncInput,
  PaymentRecordFilters,
  PaymentRecordInput,
  PayslipFilters,
} from '../dto/payrollRecord.dto.js';
import { LINE_TYPE_OF_CATEGORY } from '../../payroll-shared/payrollLineCategories.js';
import type {
  IPayrollRecordRepository,
  PayrollItemWithLines,
  PayslipRecord,
} from '../interfaces/payrollRecord.repository.interface.js';
import type {
  EmployeeSnapshot,
  IPayrollRecordService,
  IssuedPayslip,
  PaymentRecordListResult,
  PaymentView,
  PayslipListResult,
  PayslipView,
  RunItemsResult,
  RunPaymentView,
} from '../interfaces/payrollRecord.service.interface.js';
import type { IEmployeeDirectory } from '../interfaces/employeeDirectory.interface.js';

const BONUS_AWARD_SOURCE_TYPE = 'bonus_award';
const BONUS_SYNCABLE_STATUSES = ['DRAFT', 'CALCULATED', 'UNDER_REVIEW'];

const extractEmployee = (snapshot: unknown): EmployeeSnapshot | null => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const employee = (snapshot as Record<string, unknown>).employee;
  return employee && typeof employee === 'object' && !Array.isArray(employee)
    ? (employee as EmployeeSnapshot)
    : null;
};

const buildSnapshot = (
  item: {
    employeeId: string;
    baseSalary: unknown;
    grossPay: unknown;
    totalDeductions: unknown;
    netPay: unknown;
    currency: string;
    snapshot: unknown;
    lines: Array<{
      lineType: string;
      category: string;
      description: string;
      amount: unknown;
    }>;
  },
  run: { periodStart: Date; periodEnd: Date },
) => {
  const existing =
    item.snapshot && typeof item.snapshot === 'object' && !Array.isArray(item.snapshot)
      ? (item.snapshot as Record<string, unknown>)
      : {};

  const lines =
    item.lines.length > 0
      ? item.lines.map((line) => ({
          line_type: line.lineType,
          category: line.category,
          description: line.description,
          amount: Number(line.amount),
        }))
      : Array.isArray(existing.lines)
        ? existing.lines
        : [];

  return {
    ...existing,
    employee:
      existing.employee ??
      {
        id: item.employeeId,
        full_name: `Employee ${item.employeeId.slice(0, 8)}`,
        employee_code: item.employeeId.slice(0, 8).toUpperCase(),
      },
    period:
      existing.period ??
      {
        start: run.periodStart.toISOString(),
        end: run.periodEnd.toISOString(),
      },
    base_salary: existing.base_salary ?? Number(item.baseSalary),
    gross_pay: existing.gross_pay ?? Number(item.grossPay),
    total_deductions: existing.total_deductions ?? Number(item.totalDeductions),
    net_pay: existing.net_pay ?? Number(item.netPay),
    currency: existing.currency ?? item.currency,
    lines,
    generated_at: new Date().toISOString(),
  };
};

export class PayrollRecordService implements IPayrollRecordService {
  constructor(
    private readonly repository: IPayrollRecordRepository,
    private readonly employeeDirectory: IEmployeeDirectory,
  ) {}

  private async audit(
    payrollRunId: string,
    action: string,
    description?: string,
    meta?: Record<string, unknown>,
  ) {
    await this.repository.createAuditLog({
      payrollRunId,
      action,
      description: description ?? null,
      meta: meta ? (meta as never) : undefined,
    });
  }

  async listRunItems(runId: string, page = 1, perPage = 20): Promise<RunItemsResult> {
    const [items, total] = await Promise.all([
      this.repository.listRunItems(runId, (page - 1) * perPage, perPage),
      this.repository.countRunItems(runId),
    ]);

    return { items, total };
  }

  listRunAuditLogs(runId: string) {
    return this.repository.listAuditLogs(runId);
  }

  private async recalculateRunTotals(runId: string) {
    const totals = await this.repository.aggregateRunItems(runId);
    await this.repository.updateRunTotals(runId, totals);
  }

  private async applyAdjustmentDelta(
    itemId: string,
    amount: number,
    lineType: 'EARNING' | 'DEDUCTION',
  ): Promise<PayrollItemWithLines> {
    const item = await this.repository.findItemById(itemId);
    if (!item) throw new Error('Payroll item not found');

    const grossPay = Number(item.grossPay) + (lineType === 'EARNING' ? amount : 0);
    const totalDeductions =
      Number(item.totalDeductions) + (lineType === 'DEDUCTION' ? amount : 0);

    const updated = await this.repository.updateItemTotals(item.id, {
      grossPay,
      totalDeductions,
      netPay: grossPay - totalDeductions,
    });

    await this.recalculateRunTotals(item.payrollRunId);
    return updated;
  }

  async addAdjustment(
    runId: string,
    itemId: string,
    input: AdjustmentInput,
  ): Promise<PayrollItemWithLines> {
    const item = await this.repository.findItemForRun(itemId, runId);
    if (!item) throw new Error('Payroll item not found');

    const quantity = input.quantity ?? 1;
    const rate = input.rate ?? 0;
    const amount = input.amount ?? quantity * rate;
    const lineType = LINE_TYPE_OF_CATEGORY[input.category];

    await this.repository.createItemLine({
      payrollItemId: item.id,
      lineType,
      category: input.category,
      description: input.description?.trim() || input.category,
      quantity,
      rate,
      amount,
    });

    await this.audit(runId, 'ITEM_ADJUSTED', `Adjustment added: ${input.category}`, {
      payrollItemId: item.id,
      category: input.category,
      amount,
    });

    return this.applyAdjustmentDelta(item.id, amount, lineType);
  }

  async removeAdjustment(
    runId: string,
    itemId: string,
    lineId: string,
  ): Promise<PayrollItemWithLines> {
    const item = await this.repository.findItemForRun(itemId, runId);
    if (!item) throw new Error('Payroll item not found');

    const line = await this.repository.findLineForItem(lineId, item.id);
    if (!line) throw new Error('Payroll adjustment not found');
    if (line.sourceType) {
      throw new Error('System generated lines cannot be removed');
    }

    await this.repository.deleteItemLine(line.id);
    await this.audit(runId, 'ITEM_ADJUSTED', `Adjustment removed: ${line.category}`, {
      payrollItemId: item.id,
      category: line.category,
    });

    return this.applyAdjustmentDelta(
      item.id,
      -Number(line.amount),
      line.lineType as 'EARNING' | 'DEDUCTION',
    );
  }

  async generatePayslipsForRun(runId: string): Promise<IssuedPayslip[]> {
    const run = await this.repository.findRunForPayslips(runId);
    if (!run) throw new Error('Payroll run not found');

    const pending = run.items.filter((item) => !item.payslip);
    const created: PayslipRecord[] = [];

    for (const item of pending) {
      const payslip = await this.repository.createPayslip({
        payslipNumber: `PS-${run.reference}-${item.employeeId.slice(-6).toUpperCase()}`,
        payrollRunId: run.id,
        payrollItemId: item.id,
        employeeId: item.employeeId,
        status: 'GENERATED',
        generatedAt: new Date(),
        snapshot: buildSnapshot(item, run) as never,
      });
      created.push(payslip);
    }

    if (created.length > 0) {
      await this.audit(runId, 'PAYSLIP_ISSUED', `Generated ${created.length} payslip(s)`);
    }

    return created.map((payslip) => ({
      ...payslip,
      employee: extractEmployee(payslip.snapshot),
    }));
  }

  async listPayslips(filters: PayslipFilters = {}): Promise<PayslipListResult> {
    const { employeeId, payrollRunId, status, page = 1, perPage = 20 } = filters;
    const where: Prisma.PayslipWhereInput = {};

    if (employeeId) where.employeeId = employeeId;
    if (payrollRunId) where.payrollRunId = payrollRunId;
    if (status) where.status = status;

    const [payslips, total] = await Promise.all([
      this.repository.listPayslips(where, (page - 1) * perPage, perPage),
      this.repository.countPayslips(where),
    ]);

    return {
      payslips: payslips.map((payslip) => ({
        ...payslip,
        employee: extractEmployee(payslip.snapshot),
      })),
      total,
    };
  }

  async getPayslipById(id: string): Promise<PayslipView | null> {
    const payslip = await this.repository.findPayslipById(id);

    return payslip
      ? { ...payslip, employee: extractEmployee(payslip.snapshot) }
      : null;
  }

  async issuePayslip(id: string): Promise<PayslipRecord | null> {
    const payslip = await this.repository.findPayslipRecordById(id);
    if (!payslip) return null;

    const updated = await this.repository.updatePayslip(id, {
      status: 'ISSUED',
      issuedAt: new Date(),
    });
    await this.audit(updated.payrollRunId, 'PAYSLIP_ISSUED', `Payslip ${updated.payslipNumber} issued`);
    return updated;
  }

  async revokePayslip(id: string): Promise<PayslipRecord | null> {
    const payslip = await this.repository.findPayslipRecordById(id);
    if (!payslip) return null;

    const updated = await this.repository.updatePayslip(id, {
      status: 'REVOKED',
      revokedAt: new Date(),
    });
    await this.audit(updated.payrollRunId, 'PAYSLIP_REVOKED', `Payslip ${updated.payslipNumber} revoked`);
    return updated;
  }

  async listPaymentRecords(
    filters: PaymentRecordFilters = {},
  ): Promise<PaymentRecordListResult> {
    const {
      payrollRunId,
      employeeId,
      status,
      method,
      page = 1,
      perPage = 20,
    } = filters;
    const where: Prisma.PaymentRecordWhereInput = {};

    if (payrollRunId) where.payrollRunId = payrollRunId;
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (method) where.method = method;

    const [paymentRecords, total] = await Promise.all([
      this.repository.listPaymentRecords(where, (page - 1) * perPage, perPage),
      this.repository.countPaymentRecords(where),
    ]);

    return {
      paymentRecords: paymentRecords.map((record) => ({
        ...record,
        employee:
          extractEmployee(record.payrollItem?.snapshot) ?? extractEmployee(record.meta),
      })),
      total,
    };
  }

  async listRunPayments(runId: string): Promise<RunPaymentView[]> {
    const payments = await this.repository.listRunPayments(runId);

    return payments.map((record) => ({
      ...record,
      employee:
        extractEmployee(record.payrollItem?.snapshot) ?? extractEmployee(record.meta),
    }));
  }

  async recordPayment(
    runId: string,
    input: PaymentRecordInput,
  ): Promise<PaymentView> {
    const run = await this.repository.findRunById(runId);
    if (!run) throw new Error('Payroll run not found');

    const item = input.payrollItemId
      ? await this.repository.findItemForRun(input.payrollItemId, runId)
      : null;

    const employeeId = input.employeeId ?? item?.employeeId;
    if (!employeeId) throw new Error('Employee is required');

    if (item && item.employeeId !== employeeId) {
      throw new Error('Payroll item does not belong to the selected employee');
    }

    const employee = await this.employeeDirectory.findById(employeeId);
    if (!employee) {
      throw new Error('Employee must exist in employee records');
    }

    const amount = input.amount ?? Number(item?.netPay ?? 0);
    const employeeSnapshot: EmployeeSnapshot = extractEmployee(item?.snapshot) ?? {
      id: employee.id,
      full_name: employee.fullName ?? `Employee ${employee.id.slice(0, 8)}`,
      employee_code: employee.employeeCode ?? employee.id.slice(0, 8).toUpperCase(),
    };

    const payment = await this.repository.createPaymentRecord({
      payrollRunId: runId,
      payrollItemId: item?.id ?? input.payrollItemId ?? null,
      employeeId,
      method: input.method,
      status: input.status ?? 'PENDING',
      amount,
      currency: input.currency ?? run.currency,
      reference: input.reference ?? null,
      bankName: input.bankName ?? null,
      accountLast4: input.accountLast4 ?? null,
      notes: input.notes ?? null,
      paidAt: input.status === 'SUCCESS' ? new Date() : null,
      meta: { employee: employeeSnapshot } as never,
    });

    await this.audit(runId, 'PAYMENT_RECORDED', `Payment recorded for employee ${employeeId}`, {
      paymentRecordId: payment.id,
      amount,
    });

    return {
      ...payment,
      employee: employeeSnapshot,
    };
  }

  async updatePaymentStatus(
    id: string,
    status: PaymentStatus,
  ): Promise<PaymentView | null> {
    const payment = await this.repository.findPaymentRecordById(id);
    if (!payment) return null;

    const updated = await this.repository.updatePaymentRecord(id, {
      status,
      ...(status === 'SUCCESS' && !payment.paidAt ? { paidAt: new Date() } : {}),
    });

    await this.audit(
      updated.payrollRunId,
      'PAYMENT_RECORDED',
      `Payment ${updated.id} marked ${status}`,
    );
    return {
      ...updated,
      employee:
        extractEmployee(payment.payrollItem?.snapshot) ?? extractEmployee(payment.meta),
    };
  }

  async syncBonusAward(
    runId: string,
    input: BonusAwardSyncInput,
  ): Promise<PayrollItemWithLines | null> {
    const run = await this.repository.findRunById(runId);
    if (!run) throw new Error('Payroll run not found');

    if (!BONUS_SYNCABLE_STATUSES.includes(run.status)) {
      throw new Error('Bonus earnings can only be added to an editable payroll run');
    }

    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Bonus amount must be greater than zero');
    }

    const existingLine = await this.repository.findLineBySource(
      runId,
      BONUS_AWARD_SOURCE_TYPE,
      input.bonusAwardId,
    );

    if (existingLine) {
      return this.repository.findItemWithLinesById(existingLine.payrollItemId);
    }

    const employeeCode =
      input.employeeCode?.trim() ||
      input.employeeId.slice(0, 8).toUpperCase();
    const employeeName =
      input.employeeName?.trim() ||
      `Employee ${input.employeeId.slice(0, 8)}`;

    let item = await this.repository.findItemByEmployee(runId, input.employeeId);

    if (!item) {
      item = await this.repository.createPayrollItem({
        payrollRunId: runId,
        employeeId: input.employeeId,
        currency: run.currency,
        snapshot: {
          employee: {
            id: input.employeeId,
            employee_code: employeeCode,
            full_name: employeeName,
          },
          period: {
            start: run.periodStart.toISOString(),
            end: run.periodEnd.toISOString(),
          },
        } as never,
      });
    }

    await this.repository.createItemLine({
      payrollItemId: item.id,
      lineType: 'EARNING',
      category: 'BONUS',
      description:
        input.description?.trim() ||
        `Performance bonus (BA-${input.bonusAwardId.slice(0, 8).toUpperCase()})`,
      quantity: 1,
      rate: amount,
      amount,
      sourceType: BONUS_AWARD_SOURCE_TYPE,
      sourceId: input.bonusAwardId,
      meta: (input.meta ?? undefined) as never,
    });

    const updated = await this.applyAdjustmentDelta(item.id, amount, 'EARNING');
    await this.audit(runId, 'BONUS_AWARD_SYNCED', `Bonus award ${input.bonusAwardId} synced`, {
      payrollItemId: item.id,
      bonusAwardId: input.bonusAwardId,
      amount,
    });

    return updated;
  }
}
