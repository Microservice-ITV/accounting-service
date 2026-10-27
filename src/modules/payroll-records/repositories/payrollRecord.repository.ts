import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type {
  IPayrollRecordRepository,
  PaymentRecordRecord,
  PaymentRecordWithItemSnapshot,
  PaymentRecordWithRunAndItemSnapshot,
  PayrollAuditLogRecord,
  PayrollItemLineRecord,
  PayrollItemRecord,
  PayrollItemWithLines,
  PayrollRunForPayslips,
  PayrollRunRecord,
  PayslipRecord,
  PayslipWithRelations,
  RunItemTotals,
} from '../interfaces/payrollRecord.repository.interface.js';

const itemLines = { include: { lines: { orderBy: { createdAt: 'asc' as const } } } };

export class PayrollRecordRepository implements IPayrollRecordRepository {
  findRunById(id: string): Promise<PayrollRunRecord | null> {
    return prisma.payrollRun.findUnique({ where: { id } });
  }

  findRunForPayslips(id: string): Promise<PayrollRunForPayslips | null> {
    return prisma.payrollRun.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            lines: { orderBy: { createdAt: 'asc' } },
            payslip: true,
          },
        },
      },
    });
  }

  listRunItems(
    runId: string,
    skip: number,
    take: number,
  ): Promise<PayrollItemWithLines[]> {
    return prisma.payrollItem.findMany({
      where: { payrollRunId: runId },
      ...itemLines,
      orderBy: { createdAt: 'asc' },
      skip,
      take,
    });
  }

  countRunItems(runId: string): Promise<number> {
    return prisma.payrollItem.count({ where: { payrollRunId: runId } });
  }

  listAuditLogs(runId: string): Promise<PayrollAuditLogRecord[]> {
    return prisma.payrollAuditLog.findMany({
      where: { payrollRunId: runId },
      orderBy: { createdAt: 'desc' },
    });
  }

  createAuditLog(
    data: Prisma.PayrollAuditLogUncheckedCreateInput,
  ): Promise<PayrollAuditLogRecord> {
    return prisma.payrollAuditLog.create({ data });
  }

  async aggregateRunItems(runId: string): Promise<RunItemTotals> {
    const [aggregate, employeeCount] = await Promise.all([
      prisma.payrollItem.aggregate({
        where: { payrollRunId: runId },
        _sum: { grossPay: true, totalDeductions: true, netPay: true },
      }),
      prisma.payrollItem.count({ where: { payrollRunId: runId } }),
    ]);

    return {
      grossPay: Number(aggregate._sum.grossPay ?? 0),
      totalDeductions: Number(aggregate._sum.totalDeductions ?? 0),
      netPay: Number(aggregate._sum.netPay ?? 0),
      employeeCount,
    };
  }

  updateRunTotals(
    runId: string,
    totals: Pick<RunItemTotals, 'grossPay' | 'totalDeductions' | 'netPay' | 'employeeCount'>,
  ): Promise<PayrollRunRecord> {
    return prisma.payrollRun.update({
      where: { id: runId },
      data: {
        totalGross: totals.grossPay,
        totalDeductions: totals.totalDeductions,
        totalNet: totals.netPay,
        employeeCount: totals.employeeCount,
      },
    });
  }

  findItemById(id: string): Promise<PayrollItemRecord | null> {
    return prisma.payrollItem.findUnique({ where: { id } });
  }

  findItemForRun(itemId: string, runId: string): Promise<PayrollItemRecord | null> {
    return prisma.payrollItem.findFirst({
      where: { id: itemId, payrollRunId: runId },
    });
  }

  findItemByEmployee(
    runId: string,
    employeeId: string,
  ): Promise<PayrollItemRecord | null> {
    return prisma.payrollItem.findFirst({
      where: { payrollRunId: runId, employeeId },
    });
  }

  findItemWithLinesById(id: string): Promise<PayrollItemWithLines | null> {
    return prisma.payrollItem.findUnique({
      where: { id },
      ...itemLines,
    });
  }

  createPayrollItem(
    data: Prisma.PayrollItemUncheckedCreateInput,
  ): Promise<PayrollItemRecord> {
    return prisma.payrollItem.create({ data });
  }

  updateItemTotals(
    id: string,
    data: Prisma.PayrollItemUncheckedUpdateInput,
  ): Promise<PayrollItemWithLines> {
    return prisma.payrollItem.update({
      where: { id },
      data,
      ...itemLines,
    });
  }

  findLineForItem(lineId: string, itemId: string): Promise<PayrollItemLineRecord | null> {
    return prisma.payrollItemLine.findFirst({
      where: { id: lineId, payrollItemId: itemId },
    });
  }

  findLineBySource(
    runId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<{ payrollItemId: string } | null> {
    return prisma.payrollItemLine.findFirst({
      where: {
        sourceType,
        sourceId,
        payrollItem: { payrollRunId: runId },
      },
      select: { payrollItemId: true },
    });
  }

  createItemLine(
    data: Prisma.PayrollItemLineUncheckedCreateInput,
  ): Promise<PayrollItemLineRecord> {
    return prisma.payrollItemLine.create({ data });
  }

  deleteItemLine(id: string): Promise<PayrollItemLineRecord> {
    return prisma.payrollItemLine.delete({ where: { id } });
  }

  createPayslip(data: Prisma.PayslipUncheckedCreateInput): Promise<PayslipRecord> {
    return prisma.payslip.create({ data });
  }

  listPayslips(
    where: Prisma.PayslipWhereInput,
    skip: number,
    take: number,
  ): Promise<PayslipWithRelations[]> {
    return prisma.payslip.findMany({
      where,
      include: {
        payrollRun: true,
        payrollItem: { include: { lines: { orderBy: { createdAt: 'asc' } } } },
      },
      orderBy: { generatedAt: 'desc' },
      skip,
      take,
    });
  }

  countPayslips(where: Prisma.PayslipWhereInput): Promise<number> {
    return prisma.payslip.count({ where });
  }

  findPayslipById(id: string): Promise<PayslipWithRelations | null> {
    return prisma.payslip.findUnique({
      where: { id },
      include: {
        payrollRun: true,
        payrollItem: { include: { lines: { orderBy: { createdAt: 'asc' } } } },
      },
    });
  }

  findPayslipRecordById(id: string): Promise<PayslipRecord | null> {
    return prisma.payslip.findUnique({ where: { id } });
  }

  updatePayslip(
    id: string,
    data: Prisma.PayslipUncheckedUpdateInput,
  ): Promise<PayslipRecord> {
    return prisma.payslip.update({ where: { id }, data });
  }

  listPaymentRecords(
    where: Prisma.PaymentRecordWhereInput,
    skip: number,
    take: number,
  ): Promise<PaymentRecordWithRunAndItemSnapshot[]> {
    return prisma.paymentRecord.findMany({
      where,
      include: {
        payrollRun: true,
        payrollItem: { select: { snapshot: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  countPaymentRecords(where: Prisma.PaymentRecordWhereInput): Promise<number> {
    return prisma.paymentRecord.count({ where });
  }

  listRunPayments(runId: string): Promise<PaymentRecordWithItemSnapshot[]> {
    return prisma.paymentRecord.findMany({
      where: { payrollRunId: runId },
      include: { payrollItem: { select: { snapshot: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findPaymentRecordById(id: string): Promise<PaymentRecordWithItemSnapshot | null> {
    return prisma.paymentRecord.findUnique({
      where: { id },
      include: { payrollItem: { select: { snapshot: true } } },
    });
  }

  createPaymentRecord(
    data: Prisma.PaymentRecordUncheckedCreateInput,
  ): Promise<PaymentRecordRecord> {
    return prisma.paymentRecord.create({ data });
  }

  updatePaymentRecord(
    id: string,
    data: Prisma.PaymentRecordUncheckedUpdateInput,
  ): Promise<PaymentRecordRecord> {
    return prisma.paymentRecord.update({ where: { id }, data });
  }
}
