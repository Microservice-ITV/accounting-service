import type {
  PaymentRecord,
  PayrollAuditLog,
  PayrollItem,
  PayrollItemLine,
  PayrollRun,
  Payslip,
  Prisma,
} from '@prisma/client';

export type PayrollRunRecord = PayrollRun;
export type PayrollItemRecord = PayrollItem;
export type PayrollItemLineRecord = PayrollItemLine;
export type PayrollAuditLogRecord = PayrollAuditLog;
export type PayslipRecord = Payslip;
export type PaymentRecordRecord = PaymentRecord;

export type PayrollItemWithLines = Prisma.PayrollItemGetPayload<{
  include: { lines: true };
}>;

export type PayrollRunForPayslips = Prisma.PayrollRunGetPayload<{
  include: {
    items: {
      include: {
        lines: true;
        payslip: true;
      };
    };
  };
}>;

export type PayslipWithRelations = Prisma.PayslipGetPayload<{
  include: {
    payrollRun: true;
    payrollItem: { include: { lines: true } };
  };
}>;

export type PaymentRecordWithItemSnapshot = Prisma.PaymentRecordGetPayload<{
  include: { payrollItem: { select: { snapshot: true } } };
}>;

export type PaymentRecordWithRunAndItemSnapshot = Prisma.PaymentRecordGetPayload<{
  include: {
    payrollRun: true;
    payrollItem: { select: { snapshot: true } };
  };
}>;

export type RunItemTotals = {
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  employeeCount: number;
};

export interface IPayrollRecordRepository {
  findRunById(id: string): Promise<PayrollRunRecord | null>;
  findRunForPayslips(id: string): Promise<PayrollRunForPayslips | null>;
  listRunItems(runId: string, skip: number, take: number): Promise<PayrollItemWithLines[]>;
  countRunItems(runId: string): Promise<number>;
  listAuditLogs(runId: string): Promise<PayrollAuditLogRecord[]>;
  createAuditLog(
    data: Prisma.PayrollAuditLogUncheckedCreateInput,
  ): Promise<PayrollAuditLogRecord>;
  aggregateRunItems(runId: string): Promise<RunItemTotals>;
  updateRunTotals(
    runId: string,
    totals: Pick<RunItemTotals, 'grossPay' | 'totalDeductions' | 'netPay' | 'employeeCount'>,
  ): Promise<PayrollRunRecord>;
  findItemById(id: string): Promise<PayrollItemRecord | null>;
  findItemForRun(itemId: string, runId: string): Promise<PayrollItemRecord | null>;
  findItemByEmployee(
    runId: string,
    employeeId: string,
  ): Promise<PayrollItemRecord | null>;
  findItemWithLinesById(id: string): Promise<PayrollItemWithLines | null>;
  createPayrollItem(
    data: Prisma.PayrollItemUncheckedCreateInput,
  ): Promise<PayrollItemRecord>;
  updateItemTotals(
    id: string,
    data: Prisma.PayrollItemUncheckedUpdateInput,
  ): Promise<PayrollItemWithLines>;
  findLineForItem(lineId: string, itemId: string): Promise<PayrollItemLineRecord | null>;
  findLineBySource(
    runId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<{ payrollItemId: string } | null>;
  createItemLine(
    data: Prisma.PayrollItemLineUncheckedCreateInput,
  ): Promise<PayrollItemLineRecord>;
  deleteItemLine(id: string): Promise<PayrollItemLineRecord>;
  createPayslip(data: Prisma.PayslipUncheckedCreateInput): Promise<PayslipRecord>;
  listPayslips(
    where: Prisma.PayslipWhereInput,
    skip: number,
    take: number,
  ): Promise<PayslipWithRelations[]>;
  countPayslips(where: Prisma.PayslipWhereInput): Promise<number>;
  findPayslipById(id: string): Promise<PayslipWithRelations | null>;
  findPayslipRecordById(id: string): Promise<PayslipRecord | null>;
  updatePayslip(
    id: string,
    data: Prisma.PayslipUncheckedUpdateInput,
  ): Promise<PayslipRecord>;
  listPaymentRecords(
    where: Prisma.PaymentRecordWhereInput,
    skip: number,
    take: number,
  ): Promise<PaymentRecordWithRunAndItemSnapshot[]>;
  countPaymentRecords(where: Prisma.PaymentRecordWhereInput): Promise<number>;
  listRunPayments(runId: string): Promise<PaymentRecordWithItemSnapshot[]>;
  findPaymentRecordById(id: string): Promise<PaymentRecordWithItemSnapshot | null>;
  createPaymentRecord(
    data: Prisma.PaymentRecordUncheckedCreateInput,
  ): Promise<PaymentRecordRecord>;
  updatePaymentRecord(
    id: string,
    data: Prisma.PaymentRecordUncheckedUpdateInput,
  ): Promise<PaymentRecordRecord>;
}
