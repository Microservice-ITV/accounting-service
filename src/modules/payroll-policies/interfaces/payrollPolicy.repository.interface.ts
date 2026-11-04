import type { PayrollPolicy, Prisma } from '@prisma/client';

export type PayrollPolicyRecord = PayrollPolicy;

export interface IPayrollPolicyRepository {
  findMany(
    where: Prisma.PayrollPolicyWhereInput,
    skip: number,
    take: number,
  ): Promise<PayrollPolicyRecord[]>;
  count(where: Prisma.PayrollPolicyWhereInput): Promise<number>;
  findById(id: string): Promise<PayrollPolicyRecord | null>;
  findActiveForShop(shopId: string, now: Date): Promise<PayrollPolicyRecord | null>;
  findDefaultForShop(shopId: string, now: Date): Promise<PayrollPolicyRecord | null>;
  create(data: Prisma.PayrollPolicyUncheckedCreateInput): Promise<PayrollPolicyRecord>;
  update(
    id: string,
    data: Prisma.PayrollPolicyUncheckedUpdateInput,
  ): Promise<PayrollPolicyRecord>;
  delete(id: string): Promise<PayrollPolicyRecord>;
}
