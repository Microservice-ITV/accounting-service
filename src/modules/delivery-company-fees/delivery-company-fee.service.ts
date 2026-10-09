import { Prisma } from '@prisma/client';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import prisma from '../../lib/prisma.js';

export type DeliveryCompanyFeeInput = {
  shopId: string;
  deliveryCompanyId: string;
  chargingBasis: 'PER_ORDER' | 'PER_INVOICE';
  amount: string;
  currency: string;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type DeliveryCompanyFeeDatabase = Pick<typeof prisma, 'deliveryCompanyFee'>;

export function assertDeliveryCompanyFeeShopAccess(
  authContext: AuthenticatedExpenseContext | null | undefined,
  shopId: string,
): void {
  if (!authContext?.userId) throw new Error('Unauthenticated');
  const authorizedShopIds = new Set((authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (!authorizedShopIds.has(shopId)) {
    throw new Error('User is not authorized for the selected shop');
  }
}

function validateEffectiveDates(input: Pick<DeliveryCompanyFeeInput, 'effectiveFrom' | 'effectiveTo'>) {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new Error('Effective To must be greater than or equal to Effective From');
  }
}

function toPrismaInput(input: DeliveryCompanyFeeInput) {
  validateEffectiveDates(input);
  return {
    shopId: input.shopId,
    deliveryCompanyId: input.deliveryCompanyId,
    chargingBasis: input.chargingBasis,
    amount: new Prisma.Decimal(input.amount),
    currency: input.currency,
    active: input.active,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  };
}

export async function validateActiveDeliveryCompany(deliveryCompanyId: string): Promise<void> {
  const configuredBaseUrl = process.env.SHIPPING_SERVICE_BASE_URL?.trim();
  if (!configuredBaseUrl) throw new Error('SHIPPING_SERVICE_BASE_URL is not configured');
  const baseUrl = configuredBaseUrl.replace(/\/$/, '');
  const response = await fetch(
    `${baseUrl}/delivery-companies/${encodeURIComponent(deliveryCompanyId)}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (response.status === 404) throw new Error('Active Delivery Company not found');
  if (!response.ok) throw new Error(`Shipping Service could not validate the Delivery Company (HTTP ${response.status})`);
  const payload: unknown = await response.json();
  const body = payload && typeof payload === 'object' ? payload as { data?: unknown } : {};
  const company = body.data && typeof body.data === 'object'
    ? body.data as { id?: unknown; status?: unknown }
    : {};
  if (company.id !== deliveryCompanyId || company.status !== 'ACTIVE') {
    throw new Error('Active Delivery Company not found');
  }
}

export async function listDeliveryCompanyFees(
  authContext: AuthenticatedExpenseContext,
  database: DeliveryCompanyFeeDatabase = prisma,
) {
  const authorizedShopIds = [...new Set((authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (authorizedShopIds.length === 0) throw new Error('Seller is not assigned to any authorized shop');
  return database.deliveryCompanyFee.findMany({
    where: { shopId: { in: authorizedShopIds }, deliveryCompanyId: { not: null } },
    orderBy: [{ shopId: 'asc' }, { deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function listActiveShopDeliveryCompanyConfigurations(
  shopId: string,
  database: DeliveryCompanyFeeDatabase = prisma,
) {
  const now = new Date();
  return database.deliveryCompanyFee.findMany({
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

export async function isActiveShopDeliveryCompanyConfiguration(
  shopId: string,
  deliveryCompanyId: string,
  database: DeliveryCompanyFeeDatabase = prisma,
): Promise<boolean> {
  const now = new Date();
  return Boolean(await database.deliveryCompanyFee.findFirst({
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

export async function getDeliveryCompanyFee(
  id: string,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryCompanyFeeDatabase = prisma,
) {
  const feeRule = await database.deliveryCompanyFee.findUnique({ where: { id } });
  if (!feeRule || !feeRule.shopId || !feeRule.deliveryCompanyId) throw new Error('Delivery Company fee rule not found');
  assertDeliveryCompanyFeeShopAccess(authContext, feeRule.shopId);
  return feeRule;
}

export async function createDeliveryCompanyFee(
  input: DeliveryCompanyFeeInput,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryCompanyFeeDatabase = prisma,
  validateCompany: typeof validateActiveDeliveryCompany = validateActiveDeliveryCompany,
) {
  assertDeliveryCompanyFeeShopAccess(authContext, input.shopId);
  const data = toPrismaInput(input);
  await validateCompany(input.deliveryCompanyId);
  return database.deliveryCompanyFee.create({ data });
}

export async function updateDeliveryCompanyFee(
  id: string,
  input: DeliveryCompanyFeeInput,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryCompanyFeeDatabase = prisma,
  validateCompany: typeof validateActiveDeliveryCompany = validateActiveDeliveryCompany,
) {
  const existing = await database.deliveryCompanyFee.findUnique({ where: { id } });
  if (!existing?.shopId || !existing.deliveryCompanyId) throw new Error('Delivery Company fee rule not found');
  assertDeliveryCompanyFeeShopAccess(authContext, existing.shopId);
  if (input.shopId !== existing.shopId) throw new Error('Shop cannot be changed for an existing Delivery Company configuration');
  const data = toPrismaInput(input);
  await validateCompany(input.deliveryCompanyId);
  try {
    return await database.deliveryCompanyFee.update({ where: { id }, data });
  } catch (error) {
    if (isPrismaRecordNotFound(error)) throw new Error('Delivery Company fee rule not found');
    throw error;
  }
}

export async function setDeliveryCompanyFeeActive(
  id: string,
  active: boolean,
  authContext: AuthenticatedExpenseContext,
  database: DeliveryCompanyFeeDatabase = prisma,
) {
  const existing = await database.deliveryCompanyFee.findUnique({ where: { id } });
  if (!existing?.shopId || !existing.deliveryCompanyId) throw new Error('Delivery Company fee rule not found');
  assertDeliveryCompanyFeeShopAccess(authContext, existing.shopId);
  try {
    return await database.deliveryCompanyFee.update({ where: { id }, data: { active } });
  } catch (error) {
    if (isPrismaRecordNotFound(error)) throw new Error('Delivery Company fee rule not found');
    throw error;
  }
}

function isPrismaRecordNotFound(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
