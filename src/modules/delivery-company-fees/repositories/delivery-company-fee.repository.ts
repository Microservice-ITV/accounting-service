import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type { IDeliveryCompanyFeeRepository } from '../interfaces/delivery-company-fee.repository.interface.js';

export class DeliveryCompanyFeeRepository implements IDeliveryCompanyFeeRepository {
  listByShopIds(shopIds: string[]) {
    return prisma.deliveryCompanyFee.findMany({
      where: { shopId: { in: shopIds }, deliveryCompanyId: { not: null } },
      orderBy: [
        { shopId: 'asc' },
        { deliveryCompanyId: 'asc' },
        { effectiveFrom: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  findById(id: string) {
    return prisma.deliveryCompanyFee.findUnique({ where: { id } });
  }

  create(data: Prisma.DeliveryCompanyFeeCreateInput) {
    return prisma.deliveryCompanyFee.create({ data });
  }

  update(id: string, data: Prisma.DeliveryCompanyFeeUpdateInput) {
    return prisma.deliveryCompanyFee.update({ where: { id }, data });
  }

  listActiveConfigurations(shopId: string, now: Date) {
    return prisma.deliveryCompanyFee.findMany({
      where: {
        shopId,
        deliveryCompanyId: { not: null },
        active: true,
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
        ],
      },
      select: { deliveryCompanyId: true },
      orderBy: [{ deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }

  async hasActiveConfiguration(shopId: string, deliveryCompanyId: string, now: Date): Promise<boolean> {
    return Boolean(await prisma.deliveryCompanyFee.findFirst({
      where: {
        shopId,
        deliveryCompanyId,
        active: true,
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
        ],
      },
      select: { id: true },
    }));
  }
}
