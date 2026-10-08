import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import {
  assertDeliveryCompanyFeeShopAccess,
  createDeliveryCompanyFee,
  getDeliveryCompanyFee,
  listActiveShopDeliveryCompanyConfigurations,
  listDeliveryCompanyFees,
  setDeliveryCompanyFeeActive,
  updateDeliveryCompanyFee,
} from './delivery-company-fee.service.js';

const SHOP_ID = 'shop-1';
const COMPANY_ID = 'royal-company';
const seller: AuthenticatedExpenseContext = {
  userId: 'seller-1',
  role: 'shop_owner',
  activeShopId: SHOP_ID,
  authorizedShopIds: [SHOP_ID],
  shops: [],
};
const input = {
  shopId: SHOP_ID,
  deliveryCompanyId: COMPANY_ID,
  chargingBasis: 'PER_DAY' as const,
  amount: '300.00',
  currency: 'MMK',
  active: true,
  effectiveFrom: new Date('2026-10-10T00:00:00.000Z'),
  effectiveTo: null,
};

function mockDatabase() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const feeRule = {
    id: 'fee-1',
    ...input,
    amount: new Prisma.Decimal(input.amount),
    createdAt: new Date('2026-10-10T00:00:00.000Z'),
  };
  const database = {
    deliveryCompanyFee: {
      findUnique: async (args: unknown) => {
        calls.push({ method: 'findUnique', args });
        return feeRule;
      },
      findMany: async (args: unknown) => {
        calls.push({ method: 'findMany', args });
        return [feeRule];
      },
      create: async (args: unknown) => {
        calls.push({ method: 'create', args });
        return feeRule;
      },
      update: async (args: unknown) => {
        calls.push({ method: 'update', args });
        return feeRule;
      },
    },
  };
  return { calls, feeRule, database: database as never };
}

const validMapping = async () => undefined;

test('limits seller configuration access to shops assigned by Auth Service', () => {
  assert.doesNotThrow(() => assertDeliveryCompanyFeeShopAccess(seller, SHOP_ID));
  assert.throws(
    () => assertDeliveryCompanyFeeShopAccess(seller, 'another-shop'),
    /not authorized for the selected shop/,
  );
});

test('creates a fee rule using only shop and canonical company identity', async () => {
  const { calls, database } = mockDatabase();
  const result = await createDeliveryCompanyFee(input, seller, database, validMapping);

  assert.equal(result.id, 'fee-1');
  assert.equal(calls[0].method, 'create');
  const args = calls[0].args as { data: { shopId: string; deliveryCompanyId: string; amount: Prisma.Decimal; chargingBasis: string } };
  assert.equal(args.data.shopId, SHOP_ID);
  assert.equal(args.data.deliveryCompanyId, COMPANY_ID);
  assert.equal(args.data.chargingBasis, 'PER_DAY');
  assert.equal(args.data.amount.toString(), '300');
});

test('lists only fee configurations for shops assigned to the seller', async () => {
  const { calls, database } = mockDatabase();
  await listDeliveryCompanyFees(seller, database);

  assert.deepEqual(calls[0], {
    method: 'findMany',
    args: {
      where: { shopId: { in: [SHOP_ID] }, deliveryCompanyId: { not: null } },
      orderBy: [{ shopId: 'asc' }, { deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    },
  });
});

test('lists only active Delivery Company identities for checkout', async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const database = {
    deliveryCompanyFee: {
      findMany: async (args: unknown) => {
        calls.push({ method: 'findMany', args });
        return [{ deliveryCompanyId: COMPANY_ID }];
      },
    },
  } as never;

  const configurations = await listActiveShopDeliveryCompanyConfigurations(SHOP_ID, database);

  assert.deepEqual(configurations, [{ deliveryCompanyId: COMPANY_ID }]);
  const args = calls[0].args as {
    where: { shopId: string; deliveryCompanyId: { not: null }; active: boolean; AND: unknown[] };
    select: { deliveryCompanyId: boolean };
    orderBy: unknown[];
  };
  assert.equal(args.where.shopId, SHOP_ID);
  assert.deepEqual(args.where.deliveryCompanyId, { not: null });
  assert.equal(args.where.active, true);
  assert.equal(args.where.AND.length, 2);
  assert.deepEqual(args.select, { deliveryCompanyId: true });
  assert.deepEqual(args.orderBy, [{ deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }]);
});

test('loads a fee rule by ID only when it belongs to an authorized shop', async () => {
  const { calls, database, feeRule } = mockDatabase();
  const result = await getDeliveryCompanyFee('fee-1', seller, database);

  assert.equal(result.id, 'fee-1');
  assert.deepEqual(calls[0], { method: 'findUnique', args: { where: { id: 'fee-1' } } });

  const foreignRuleDatabase = {
    deliveryCompanyFee: {
      findUnique: async () => ({ ...feeRule, shopId: 'another-shop' }),
    },
  } as never;
  await assert.rejects(getDeliveryCompanyFee('fee-foreign', seller, foreignRuleDatabase), /not authorized/);
});

test('updates a shop configuration and changes active status without deleting history', async () => {
  const { calls, database } = mockDatabase();
  await updateDeliveryCompanyFee('fee-1', { ...input, chargingBasis: 'PER_ORDER' }, seller, database, validMapping);
  await setDeliveryCompanyFeeActive('fee-1', false, seller, database);

  assert.deepEqual(calls.map((call) => call.method), ['findUnique', 'update', 'findUnique', 'update']);
  assert.deepEqual((calls[3].args as { data: { active: boolean } }).data, { active: false });
});

test('rejects moving a fee configuration to another shop', async () => {
  const { calls, database } = mockDatabase();
  await assert.rejects(
    updateDeliveryCompanyFee('fee-1', { ...input, shopId: 'another-shop' }, seller, database, validMapping),
    /Shop cannot be changed/,
  );
  assert.equal(calls.length, 1);
});

test('rejects an effective end date earlier than its start date', async () => {
  const { calls, database } = mockDatabase();
  await assert.rejects(
    () => createDeliveryCompanyFee({
      ...input,
      effectiveTo: new Date('2026-10-09T23:59:59.000Z'),
    }, seller, database, validMapping),
    /Effective To must be greater than or equal to Effective From/,
  );
  assert.equal(calls.length, 0);
});
