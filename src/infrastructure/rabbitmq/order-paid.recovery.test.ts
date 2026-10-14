import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertRecoveryEnvironment,
  recoverOrderPaidProjection,
  type OrderPaidRecoveryDependencies,
  type RecoveryJournalRecord,
  type RecoveryProjectionRecord,
} from './order-paid.recovery.js';
import { buildPnlOrderShopProjections } from './payment.consumer.js';

const eventId = 'order-paid-event-1';
const orderId = 'order-1';
const paymentId = 'payment-1';
const shopId = 'shop-1';

function orderPaidEvent() {
  return {
    event_id: eventId,
    event: 'order.paid' as const,
    timestamp: '2026-10-13T11:01:15.000Z',
    data: {
      order_id: orderId,
      payment_id: paymentId,
      currency: 'USD',
      promotion_allocations: [{
        promotion_id: 'promotion-new',
        shop_id: shopId,
        discount_type: 'ITEM' as const,
        funded_by: 'SELLER' as const,
        amount: 5,
      }],
      shop_breakdown: [{
        shop_id: shopId,
        shop_order_id: 'shop-order-1',
        subtotal: 81.16,
        discount_total: 5,
        shipping_total: 0,
        grand_total: 76.16,
      }],
    },
  };
}

function projectionRecord(
  projection: ReturnType<typeof buildPnlOrderShopProjections>[number],
): RecoveryProjectionRecord {
  return {
    orderId: projection.orderId,
    shopId: projection.shopId,
    sourceEventId: projection.sourceEventId,
    shopOrderId: projection.shopOrderId,
    currency: projection.currency,
    grossItemSales: projection.grossItemSales,
    discountTotal: projection.discountTotal,
    shippingTotal: projection.shippingTotal,
    paidAmount: projection.paidAmount,
    orderPaidAt: projection.orderPaidAt,
    discounts: projection.discounts.map((discount) => ({
      promotionId: discount.promotionId,
      rewardId: discount.rewardId,
      discountType: discount.discountType,
      fundedBy: discount.fundedBy,
      amount: discount.amount,
    })),
  };
}

function createHarness(options: {
  existing?: RecoveryProjectionRecord[];
  failFirstWrite?: boolean;
  settlement?: boolean;
  journals?: RecoveryJournalRecord[];
} = {}) {
  const committed = new Map((options.existing ?? []).map((row) => [row.shopId, row]));
  let writes = 0;
  let fail = options.failFirstWrite ?? false;
  const dependencies: OrderPaidRecoveryDependencies = {
    withTransaction: async (work) => {
      const transactionRows = new Map(committed);
      const tx = {
        findProjections: async () => [...transactionRows.values()],
        findSettlement: async () => options.settlement ? { paymentReference: paymentId } : null,
        findRelatedJournals: async () => options.journals ?? [],
        upsertProjection: async (projection: ReturnType<typeof buildPnlOrderShopProjections>[number]) => {
          writes += 1;
          if (fail) {
            fail = false;
            transactionRows.set(projection.shopId, projectionRecord(projection));
            throw new Error('simulated transaction failure');
          }
          transactionRows.set(projection.shopId, projectionRecord(projection));
        },
      };
      const result = await work(tx);
      committed.clear();
      for (const [shop, row] of transactionRows) committed.set(shop, row);
      return result;
    },
  };
  return { dependencies, committed, get writes() { return writes; } };
}

function expectedIds() {
  return { eventId, orderId, paymentId };
}

test('replaying the same stored order.paid event twice is idempotent', async () => {
  const harness = createHarness();
  await recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies);
  await recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies);

  assert.equal(harness.committed.size, 1);
  assert.equal(harness.committed.get(shopId)?.sourceEventId, eventId);
  assert.equal(harness.writes, 2);
  assert.deepEqual(harness.committed.get(shopId)?.discounts, [{
    promotionId: 'promotion-new',
    rewardId: null,
    discountType: 'ITEM',
    fundedBy: 'SELLER',
    amount: 5,
  }]);
});

test('matching existing projection replaces its discount allocations from the exact event', async () => {
  const projection = buildPnlOrderShopProjections(orderPaidEvent())[0];
  const existing = projectionRecord(projection);
  existing.discounts = [{
    promotionId: 'stale-promotion',
    rewardId: null,
    discountType: 'ITEM',
    fundedBy: 'PLATFORM',
    amount: 5,
  }];
  const harness = createHarness({ existing: [existing] });

  await recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies);

  assert.equal(harness.committed.size, 1);
  assert.deepEqual(harness.committed.get(shopId)?.discounts, [{
    promotionId: 'promotion-new',
    rewardId: null,
    discountType: 'ITEM',
    fundedBy: 'SELLER',
    amount: 5,
  }]);
});

test('transaction failure leaves no projection and retry succeeds', async () => {
  const harness = createHarness({ failFirstWrite: true });

  await assert.rejects(
    recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies),
    /simulated transaction failure/,
  );
  assert.equal(harness.committed.size, 0);

  await recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies);
  assert.equal(harness.committed.size, 1);
});

test('recovery refuses a pre-existing settlement or payment journal', async () => {
  const settlementHarness = createHarness({ settlement: true });
  await assert.rejects(
    recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), settlementHarness.dependencies),
    /Payment settlement already exists/,
  );
  assert.equal(settlementHarness.committed.size, 0);

  const journalHarness = createHarness({
    journals: [{ referenceType: 'PAYMENT', referenceId: paymentId, eventId: 'income-event' }],
  });
  await assert.rejects(
    recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), journalHarness.dependencies),
    /Payment journal already exists/,
  );
  assert.equal(journalHarness.committed.size, 0);
});

test('recovery refuses production unless both explicit approvals and production mode are present', () => {
  const base = {
    requestedEnvironment: 'production',
    configuredEnvironment: 'production',
    nodeEnvironment: 'production',
    expectedHost: 'accounting-prod-db',
    actualHost: 'accounting-prod-db',
    expectedDatabase: 'accounting_service',
    actualDatabase: 'accounting_service',
    allowProductionFlag: false,
    allowProductionEnvironmentVariable: 'false',
  };
  assert.throws(() => assertRecoveryEnvironment(base), /two explicit approvals/);
  assert.doesNotThrow(() => assertRecoveryEnvironment({
    ...base,
    allowProductionFlag: true,
    allowProductionEnvironmentVariable: 'true',
  }));
  assert.throws(() => assertRecoveryEnvironment({
    ...base,
    requestedEnvironment: 'development',
    configuredEnvironment: 'development',
    nodeEnvironment: 'production',
  }), /production-mode process/);
});

test('recovery refuses a pre-existing projection from a different event', async () => {
  const expected = projectionRecord(buildPnlOrderShopProjections(orderPaidEvent())[0]);
  expected.sourceEventId = 'different-event';
  const harness = createHarness({ existing: [expected] });

  await assert.rejects(
    recoverOrderPaidProjection(orderPaidEvent(), expectedIds(), harness.dependencies),
    /Existing projection conflicts/,
  );
  assert.equal(harness.writes, 0);
});
