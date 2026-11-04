import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type {
  IPayrollPolicyRepository,
  PayrollPolicyRecord,
} from '../interfaces/payrollPolicy.repository.interface.js';

export class PayrollPolicyRepository implements IPayrollPolicyRepository {
  findMany(
    where: Prisma.PayrollPolicyWhereInput,
    skip: number,
    take: number,
  ): Promise<PayrollPolicyRecord[]> {
    return prisma.payrollPolicy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  count(where: Prisma.PayrollPolicyWhereInput): Promise<number> {
    return prisma.payrollPolicy.count({ where });
  }

  findById(id: string): Promise<PayrollPolicyRecord | null> {
    return prisma.payrollPolicy.findUnique({ where: { id } });
  }

  findActiveForShop(shopId: string, now: Date): Promise<PayrollPolicyRecord | null> {
    return prisma.payrollPolicy.findFirst({
      where: {
        shopId,
        isActive: true,
        OR: [
          { effectiveFrom: null },
          { effectiveFrom: { lte: now } },
        ],
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        ],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  findDefaultForShop(shopId: string, now: Date): Promise<PayrollPolicyRecord | null> {
    return prisma.payrollPolicy.findFirst({
      where: {
        shopId,
        isActive: true,
        effectiveFrom: null,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
      },
    });
  }

  create(data: Prisma.PayrollPolicyUncheckedCreateInput): Promise<PayrollPolicyRecord> {
    return prisma.payrollPolicy.create({ data });
  }

  update(
    id: string,
    data: Prisma.PayrollPolicyUncheckedUpdateInput,
  ): Promise<PayrollPolicyRecord> {
    return prisma.payrollPolicy.update({ where: { id }, data });
  }

  delete(id: string): Promise<PayrollPolicyRecord> {
    return prisma.payrollPolicy.delete({ where: { id } });
  }
}
