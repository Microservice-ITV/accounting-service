import { Prisma } from '@prisma/client';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import prisma from '../../lib/prisma.js';

export type DeliveryProviderFeeInput = {
  providerId: string;
  chargingBasis: 'PER_ORDER' | 'PER_DAY';
  amount: string;
  currency: string;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type DeliveryProviderFeeDatabase = Pick<typeof prisma, 'deliveryProviderFee'>;

const platformFeeAdminRoles = new Set(['platform_super_admin', 'super_admin']);

export function assertDeliveryProviderFeeAdmin(
  authContext: AuthenticatedExpenseContext | null | undefined,
): void {
  if (!authContext?.userId) throw new Error('Unauthenticated');
  if (!platformFeeAdminRoles.has(authContext.role?.trim().toLowerCase() ?? '')) {
    throw new Error('Only a platform administrator can manage delivery provider fee rules');
  }
}

function validateEffectiveDates(input: Pick<DeliveryProviderFeeInput, 'effectiveFrom' | 'effectiveTo'>) {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new Error('Effective To must be greater than or equal to Effective From');
  }
}

function toPrismaInput(input: DeliveryProviderFeeInput) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.providerId)) {
    throw new Error('Provider ID must be a valid Delivery Service UUID');
  }
  validateEffectiveDates(input);
  return {
    providerId: input.providerId,
    chargingBasis: input.chargingBasis,
    amount: new Prisma.Decimal(input.amount),
    currency: input.currency,
    active: input.active,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  };
}

export async function listDeliveryProviderFees(
  authContext: AuthenticatedExpenseContext,
  database: DeliveryProviderFeeDatabase = prisma,
) {
  assertDeliveryProviderFeeAdmin(authContext);
  return database.deliveryProviderFee.findMany({
    orderBy: [{ providerId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getDeliveryProviderFee(
  id: string,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryProviderFeeDatabase = prisma,
) {
  assertDeliveryProviderFeeAdmin(authContext);
  const feeRule = await database.deliveryProviderFee.findUnique({ where: { id } });
  if (!feeRule) throw new Error('Delivery provider fee rule not found');
  return feeRule;
}

export async function createDeliveryProviderFee(
  input: DeliveryProviderFeeInput,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryProviderFeeDatabase = prisma,
) {
  assertDeliveryProviderFeeAdmin(authContext);
  return database.deliveryProviderFee.create({ data: toPrismaInput(input) });
}

export async function updateDeliveryProviderFee(
  id: string,
  input: DeliveryProviderFeeInput,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryProviderFeeDatabase = prisma,
) {
  assertDeliveryProviderFeeAdmin(authContext);
  validateEffectiveDates(input);
  try {
    return await database.deliveryProviderFee.update({
      where: { id },
      data: toPrismaInput(input),
    });
  } catch (error) {
    if (isPrismaRecordNotFound(error)) throw new Error('Delivery provider fee rule not found');
    throw error;
  }
}

export async function setDeliveryProviderFeeActive(
  id: string,
  active: boolean,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryProviderFeeDatabase = prisma,
) {
  assertDeliveryProviderFeeAdmin(authContext);
  try {
    return await database.deliveryProviderFee.update({
      where: { id },
      data: { active },
    });
  } catch (error) {
    if (isPrismaRecordNotFound(error)) throw new Error('Delivery provider fee rule not found');
    throw error;
  }
}

function isPrismaRecordNotFound(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
