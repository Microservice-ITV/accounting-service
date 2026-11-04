import type { PayrollRun, Prisma } from '@prisma/client';

export type PayrollRunRecord = PayrollRun;
export type PayrollRunWithDetails = Prisma.PayrollRunGetPayload<{
  include: {
    payrollPolicy: true;
    items: { include: { lines: true } };
  };
}>;

export interface IPayrollRunRepository {
  findMany(
    where: Prisma.PayrollRunWhereInput,
    skip: number,
    take: number,
  ): Promise<PayrollRunRecord[]>;
  count(where: Prisma.PayrollRunWhereInput): Promise<number>;
  findById(id: string): Promise<PayrollRunWithDetails | null>;
  create(data: Prisma.PayrollRunUncheckedCreateInput): Promise<PayrollRunRecord>;
  update(
    id: string,
    data: Prisma.PayrollRunUncheckedUpdateInput,
  ): Promise<PayrollRunRecord>;
}
