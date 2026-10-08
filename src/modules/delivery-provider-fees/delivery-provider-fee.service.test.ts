import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import {
  assertDeliveryProviderFeeAdmin,
  createDeliveryProviderFee,
  getDeliveryProviderFee,
  listDeliveryProviderFees,
  setDeliveryProviderFeeActive,
  updateDeliveryProviderFee,
} from './delivery-provider-fee.service.js';

const admin: AuthenticatedExpenseContext = {
  userId: 'admin-1',
  role: 'platform_super_admin',
  activeShopId: null,
  authorizedShopIds: [],
  shops: [],
};
const input = {
  providerId: randomUUID(),
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
    deliveryProviderFee: {
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
  return { calls, database: database as never };
}

test('only platform administrators can manage delivery provider fee rules', () => {
  assert.doesNotThrow(() => assertDeliveryProviderFeeAdmin(admin));
  assert.throws(
    () => assertDeliveryProviderFeeAdmin({ ...admin, role: 'shop_owner' }),
    /Only a platform administrator/,
  );
});

test('rejects malformed provider IDs when configuring a fee rule', async () => {
  const { calls, database } = mockDatabase();

  await assert.rejects(
    createDeliveryProviderFee({ ...input, providerId: 'not-a-delivery-provider-uuid' }, admin, database),
    /valid Delivery Service UUID/,
  );
  assert.equal(calls.length, 0);
});

test('creates an external-provider fee rule without a provider master lookup', async () => {
  const { calls, database } = mockDatabase();
  const result = await createDeliveryProviderFee(input, admin, database);

  assert.equal(result.id, 'fee-1');
  assert.equal(calls[0].method, 'create');
  const args = calls[0].args as { data: { providerId: string; amount: Prisma.Decimal; chargingBasis: string } };
  assert.equal(args.data.providerId, input.providerId);
  assert.equal(args.data.chargingBasis, 'PER_DAY');
  assert.equal(args.data.amount.toString(), '300');
});

test('lists fee rules by provider and newest effective date', async () => {
  const { calls, database } = mockDatabase();
  await listDeliveryProviderFees(admin, database);

  assert.deepEqual(calls[0], {
    method: 'findMany',
    args: { orderBy: [{ providerId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }] },
  });
});

test('loads a fee rule by ID', async () => {
  const { calls, database } = mockDatabase();
  const result = await getDeliveryProviderFee('fee-1', admin, database);

  assert.equal(result.id, 'fee-1');
  assert.deepEqual(calls[0], { method: 'findUnique', args: { where: { id: 'fee-1' } } });
});

test('updates the full fee rule and changes active status without deleting history', async () => {
  const { calls, database } = mockDatabase();
  await updateDeliveryProviderFee('fee-1', { ...input, chargingBasis: 'PER_ORDER' }, admin, database);
  await setDeliveryProviderFeeActive('fee-1', false, admin, database);

  assert.deepEqual(calls.map((call) => call.method), ['update', 'update']);
  assert.deepEqual((calls[1].args as { data: { active: boolean } }).data, { active: false });
});

test('rejects an effective end date earlier than its start date', async () => {
  const { calls, database } = mockDatabase();
  await assert.rejects(
    () => createDeliveryProviderFee({
      ...input,
      effectiveTo: new Date('2026-10-09T23:59:59.000Z'),
    }, admin, database),
    /Effective To must be greater than or equal to Effective From/,
  );
  assert.equal(calls.length, 0);
});
