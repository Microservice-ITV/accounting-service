import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import type { IDeliveryCompanyFeeRepository } from './interfaces/delivery-company-fee.repository.interface.js';
import { DeliveryCompanyFeeAuthorizationPolicy } from './policies/delivery-company-fee-authorization.policy.js';
import { DeliveryCompanyFeeService } from './services/delivery-company-fee.service.js';
import {
  DeliveryCompanyFeeApplicationError,
} from './errors/delivery-company-fee.error.js';
import { deliveryCompanyFeeSchema } from './dto/delivery-company-fee.dto.js';

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
  chargingBasis: 'PER_INVOICE' as const,
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
    updatedAt: new Date('2026-10-10T00:00:00.000Z'),
  };
  const repository: IDeliveryCompanyFeeRepository = {
    findById: async (id) => {
      calls.push({ method: 'findUnique', args: { where: { id } } });
      return feeRule;
    },
    listByShopIds: async (shopIds) => {
      calls.push({
        method: 'findMany',
        args: {
          where: { shopId: { in: shopIds }, deliveryCompanyId: { not: null } },
          orderBy: [{ shopId: 'asc' }, { deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        },
      });
      return [feeRule];
    },
    create: async (data) => {
      calls.push({ method: 'create', args: { data } });
      return feeRule;
    },
    update: async (id, data) => {
      calls.push({ method: 'update', args: { where: { id }, data } });
      return feeRule;
    },
    listActiveConfigurations: async (shopId, now) => {
      calls.push({
        method: 'findMany',
        args: {
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
        },
      });
      return [{ deliveryCompanyId: COMPANY_ID }];
    },
    hasActiveConfiguration: async (shopId, deliveryCompanyId, now) => {
      calls.push({
        method: 'findFirst',
        args: { shopId, deliveryCompanyId, now },
      });
      return true;
    },
  };
  return { calls, feeRule, repository };
}

const validMapping = async () => undefined;

test('limits seller configuration access to shops assigned by Auth Service', () => {
  const policy = new DeliveryCompanyFeeAuthorizationPolicy();
  assert.doesNotThrow(() => policy.requireShopAccess(seller, SHOP_ID));
  assert.throws(
    () => policy.requireShopAccess(seller, 'another-shop'),
    /not authorized for the selected shop/,
  );
});

test('creates a fee rule using only shop and canonical company identity', async () => {
  const { calls, repository } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository, undefined, validMapping);
  const result = await service.create(input, seller);

  assert.equal(result.id, 'fee-1');
  assert.equal(calls[0].method, 'create');
  const args = calls[0].args as { data: { shopId: string; deliveryCompanyId: string; amount: Prisma.Decimal; chargingBasis: string } };
  assert.equal(args.data.shopId, SHOP_ID);
  assert.equal(args.data.deliveryCompanyId, COMPANY_ID);
  assert.equal(args.data.chargingBasis, 'PER_INVOICE');
  assert.equal(args.data.amount.toString(), '300');
});

test('lists only fee configurations for shops assigned to the seller', async () => {
  const { calls, repository } = mockDatabase();
  await new DeliveryCompanyFeeService(repository).list(seller);

  assert.deepEqual(calls[0], {
    method: 'findMany',
    args: {
      where: { shopId: { in: [SHOP_ID] }, deliveryCompanyId: { not: null } },
      orderBy: [{ shopId: 'asc' }, { deliveryCompanyId: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    },
  });
});

test('lists only active Delivery Company identities for checkout', async () => {
  const { calls, repository } = mockDatabase();
  const configurations = await new DeliveryCompanyFeeService(repository).listActiveConfigurations(SHOP_ID);

  assert.deepEqual(configurations, [{ deliveryCompanyId: COMPANY_ID }]);
  assert.equal(calls[0].method, 'findMany');
  assert.deepEqual((calls[0].args as { where: { shopId: string } }).where.shopId, SHOP_ID);
});

test('loads a fee rule by ID only when it belongs to an authorized shop', async () => {
  const { calls, repository, feeRule } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository);
  const result = await service.get('fee-1', seller);

  assert.equal(result.id, 'fee-1');
  assert.deepEqual(calls[0], { method: 'findUnique', args: { where: { id: 'fee-1' } } });

  const foreignRuleRepository = {
    ...repository,
    findById: async () => ({ ...feeRule, shopId: 'another-shop' }),
  };
  await assert.rejects(
    new DeliveryCompanyFeeService(foreignRuleRepository).get('fee-foreign', seller),
    /not authorized/,
  );
});

test('updates a shop configuration and changes active status without deleting history', async () => {
  const { calls, repository } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository, undefined, validMapping);
  await service.update('fee-1', { ...input, chargingBasis: 'PER_ORDER' }, seller);
  await service.setActive('fee-1', false, seller);

  assert.deepEqual(calls.map((call) => call.method), ['findUnique', 'update', 'findUnique', 'update']);
  assert.deepEqual((calls[3].args as { data: { active: boolean } }).data, { active: false });
});

test('rejects moving a fee configuration to another shop', async () => {
  const { calls, repository } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository, undefined, validMapping);
  await assert.rejects(
    service.update('fee-1', { ...input, shopId: 'another-shop' }, seller),
    /Shop cannot be changed/,
  );
  assert.equal(calls.length, 1);
});

test('rejects an effective end date earlier than its start date', async () => {
  const { calls, repository } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository, undefined, validMapping);
  await assert.rejects(
    () => service.create({
      ...input,
      effectiveTo: new Date('2026-10-09T23:59:59.000Z'),
    }, seller),
    /Effective To must be greater than or equal to Effective From/,
  );
  assert.equal(calls.length, 0);
});

test('validates fee amounts, currency, and effective dates at the request boundary', () => {
  const parsed = deliveryCompanyFeeSchema.parse({
    ...input,
    amount: 300,
    currency: 'mmk',
    effectiveFrom: '2026-10-10T00:00:00.000Z',
    effectiveTo: null,
  });
  assert.equal(parsed.amount, '300');
  assert.equal(parsed.currency, 'MMK');
  assert.equal(parsed.effectiveFrom.toISOString(), '2026-10-10T00:00:00.000Z');

  assert.equal(deliveryCompanyFeeSchema.safeParse({
    ...input,
    amount: '0',
  }).success, false);
  assert.equal(deliveryCompanyFeeSchema.safeParse({
    ...input,
    amount: '1.001',
  }).success, false);
  assert.equal(deliveryCompanyFeeSchema.safeParse({
    ...input,
    currency: 'MM',
  }).success, false);
  assert.equal(deliveryCompanyFeeSchema.safeParse({
    ...input,
    effectiveTo: new Date('2026-10-09T00:00:00.000Z').toISOString(),
  }).success, false);
});

test('maps unauthenticated, inactive company, and missing fee errors to typed statuses', async () => {
  const { feeRule, repository } = mockDatabase();
  const service = new DeliveryCompanyFeeService(repository, undefined, async () => {
    throw new DeliveryCompanyFeeApplicationError('Active Delivery Company not found', 404);
  });

  await assert.rejects(
    service.create(input, { ...seller, authorizedShopIds: [] }),
    (error: unknown) => error instanceof DeliveryCompanyFeeApplicationError && error.statusCode === 403,
  );
  await assert.rejects(
    service.create(input, seller),
    (error: unknown) => error instanceof DeliveryCompanyFeeApplicationError && error.statusCode === 404,
  );
  await assert.rejects(
    new DeliveryCompanyFeeService({
      ...repository,
      findById: async () => null,
    }).get('missing', seller),
    (error: unknown) => error instanceof DeliveryCompanyFeeApplicationError && error.statusCode === 404,
  );
  assert.equal(feeRule.id, 'fee-1');
});
