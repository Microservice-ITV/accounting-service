import type { PaymentStatus, PayslipStatus } from '@prisma/client';
import type {
  AdjustmentInput,
  BonusAwardSyncInput,
  PaymentRecordFilters,
  PaymentRecordInput,
  PayslipFilters,
} from '../dto/payrollRecord.dto.js';
import type {
  PaymentRecordRecord,
  PaymentRecordWithItemSnapshot,
  PaymentRecordWithRunAndItemSnapshot,
  PayrollAuditLogRecord,
  PayrollItemWithLines,
  PayrollRunRecord,
  PayslipRecord,
  PayslipWithRelations,
} from './payrollRecord.repository.interface.js';

export type EmployeeSnapshot = Record<string, unknown>;
export type PayslipView = PayslipWithRelations & {
  employee: EmployeeSnapshot | null;
};
export type PaymentRecordView = PaymentRecordWithRunAndItemSnapshot & {
  employee: EmployeeSnapshot | null;
};
export type RunPaymentView = PaymentRecordWithItemSnapshot & {
  employee: EmployeeSnapshot | null;
};
export type PaymentView = PaymentRecordRecord & {
  employee: EmployeeSnapshot | null;
};

export type RunItemsResult = {
  items: PayrollItemWithLines[];
  total: number;
};

export type PayslipListResult = {
  payslips: PayslipView[];
  total: number;
};

export type PaymentRecordListResult = {
  paymentRecords: PaymentRecordView[];
  total: number;
};

export type IssuedPayslip = PayslipRecord & {
  employee: EmployeeSnapshot | null;
};

export interface IPayrollRecordService {
  listRunItems(runId: string, page?: number, perPage?: number): Promise<RunItemsResult>;
  listRunAuditLogs(runId: string): Promise<PayrollAuditLogRecord[]>;
  addAdjustment(
    runId: string,
    itemId: string,
    input: AdjustmentInput,
  ): Promise<PayrollItemWithLines>;
  removeAdjustment(
    runId: string,
    itemId: string,
    lineId: string,
  ): Promise<PayrollItemWithLines>;
  generatePayslipsForRun(runId: string): Promise<IssuedPayslip[]>;
  listPayslips(filters?: PayslipFilters): Promise<PayslipListResult>;
  getPayslipById(id: string): Promise<PayslipView | null>;
  issuePayslip(id: string): Promise<PayslipRecord | null>;
  revokePayslip(id: string): Promise<PayslipRecord | null>;
  listPaymentRecords(
    filters?: PaymentRecordFilters,
  ): Promise<PaymentRecordListResult>;
  listRunPayments(runId: string): Promise<RunPaymentView[]>;
  recordPayment(runId: string, input: PaymentRecordInput): Promise<PaymentView>;
  updatePaymentStatus(
    id: string,
    status: PaymentStatus,
  ): Promise<PaymentView | null>;
  syncBonusAward(
    runId: string,
    input: BonusAwardSyncInput,
  ): Promise<PayrollItemWithLines | null>;
}

export type { PayrollRunRecord, PayslipStatus };
