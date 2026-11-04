import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type {
  IPayrollRunRepository,
  PayrollRunRecord,
  PayrollRunWithDetails,
} from '../interfaces/payrollRun.repository.interface.js';

export class PayrollRunRepository implements IPayrollRunRepository {
  findMany(
    where: Prisma.PayrollRunWhereInput,
    skip: number,
    take: number,
  ): Promise<PayrollRunRecord[]> {
    return prisma.payrollRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  count(where: Prisma.PayrollRunWhereInput): Promise<number> {
    return prisma.payrollRun.count({ where });
  }

  findById(id: string): Promise<PayrollRunWithDetails | null> {
    return prisma.payrollRun.findUnique({
      where: { id },
      include: {
        payrollPolicy: true,
        items: {
          include: { lines: { orderBy: { createdAt: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  create(data: Prisma.PayrollRunUncheckedCreateInput): Promise<PayrollRunRecord> {
    return prisma.payrollRun.create({ data });
  }

  update(
    id: string,
    data: Prisma.PayrollRunUncheckedUpdateInput,
  ): Promise<PayrollRunRecord> {
    return prisma.payrollRun.update({ where: { id }, data });
  }
}
