import type { DeliveryCompanyFee, Prisma } from '@prisma/client';

export interface IDeliveryCompanyFeeRepository {
  listByShopIds(shopIds: string[]): Promise<DeliveryCompanyFee[]>;
  findById(id: string): Promise<DeliveryCompanyFee | null>;
  create(data: Prisma.DeliveryCompanyFeeCreateInput): Promise<DeliveryCompanyFee>;
  update(id: string, data: Prisma.DeliveryCompanyFeeUpdateInput): Promise<DeliveryCompanyFee>;
  listActiveConfigurations(shopId: string, now: Date): Promise<Array<{ deliveryCompanyId: string | null }>>;
  hasActiveConfiguration(shopId: string, deliveryCompanyId: string, now: Date): Promise<boolean>;
}
