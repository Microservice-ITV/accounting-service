import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCollectedPaymentJournalEventId,
  buildPnlOrderShopProjections,
  buildOrderPaidPaymentJournalEventId,
  isPermanentError,
  normalizeOrderPaidEvent,
  normalizePaymentCompletedEvent,
  normalizePaymentCollectedEvent,
  normalizePaymentEvent,
  processOrderPaid,
  processPaymentCollected,
  resolvePaymentJournalEventId,
  shouldRecognizeOrderPaidIncome,
  shouldRecognizePaymentEvent,
  validateCodOrderPaidEvent,
  type PaymentCollectedProcessorDependencies,
} from './payment.consumer.js';

const orders = Array.from({ length: 5 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const payments = Array.from({ length: 5 }, (_, index) =>
  `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const batchId = '6cd6ec31-49e3-4d1d-b493-36744687b540';
const firstEventId = '83f7726c-67bc-44b1-ad1f-1bb6fd9accdf';

test('missing accounting accounts remain retryable after master data is repaired', () => {
  assert.equal(isPermanentError(new Error('Unknown account codes: 5000, 1000')), false);
  assert.equal(isPermanentError(new Error('Journal entry is out of balance: DEBIT 100 != CREDIT 90')), true);
});

test('payment event dispatcher selects schemas by the event name', () => {
  const orderPaid = normalizePaymentEvent({
    event_id: 'order-paid-event',
    event: 'order.paid',
    data: {
      order_id: orders[0],
      shop_breakdown: [{
        shop_id: 'shop-a',
        subtotal: 100,
        grand_total: 100,
      }],
    },
  });
  const paymentCollected = normalizePaymentEvent({
    event_id: 'payment-collected-event',
    event: 'payment.collected',
    data: {
      payment_id: payments[0],
      amount: 100,
      currency: 'MMK',
      payment_method: 'cod',
      collected_at: '2026-10-09T03:24:34.000Z',
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 100 }],
    },
  });

  assert.equal(orderPaid.event, 'order.paid');
  assert.equal(paymentCollected.event, 'payment.collected');
});

function collectedEvent(index: number) {
  const eventId = index === 0
    ? firstEventId
    : `event-${String(index + 1)}`;
  return normalizePaymentCollectedEvent({
    event_id: eventId,
    event: 'payment.collected',
    data: {
      payment_id: payments[index],
      order_id: orders[index],
      checkout_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      amount: 100,
      currency: 'MMK',
      payment_method: 'cod',
      collected_at: '2026-10-09T03:24:34.000Z',
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 100 }],
      delivery_expense_group: {
        group_id: batchId,
        shop_id: 'shop-a',
        delivery_company_id: 'company-bee',
        order_ids: orders,
        effective_at: '2026-10-09T03:24:34+00:00',
      },
    },
  });
}

function orderPaidEvent(paymentStatus: 'COD' | 'PAID' = 'PAID') {
  return normalizeOrderPaidEvent({
    event_id: firstEventId,
    event: 'order.paid',
    data: {
      order_id: orders[0],
      payment_id: payments[0],
      status: 'ORDER_PAID',
      payment_status: paymentStatus,
      amount: 100,
      currency: 'MMK',
      shop_breakdown: [{
        shop_id: 'shop-a',
        subtotal: 100,
        grand_total: 100,
      }],
    },
  });
}

test('valid payment.completed is recognized for online methods but deferred for COD', () => {
  const onlineEvent = normalizePaymentEvent({
    event_id: firstEventId,
    event: 'payment.completed',
    data: {
      payment_id: payments[0],
      order_id: orders[0],
      amount: 100,
      currency: 'MMK',
      payment_method: 'card',
      status: 'SUCCESS',
    },
  });
  const codEvent = normalizePaymentEvent({
    event_id: 'cod-completed-event',
    event: 'payment.completed',
    data: {
      payment_id: payments[1],
      order_id: orders[1],
      amount: 100,
      currency: 'MMK',
      payment_method: 'cod',
      status: 'SUCCESS',
    },
  });

  assert.equal(shouldRecognizePaymentEvent(onlineEvent), true);
  assert.equal(shouldRecognizePaymentEvent(codEvent), false);
});

test('payment.collected requires explicit COD collection and validates amount and currency', () => {
  assert.equal(normalizePaymentCollectedEvent(collectedEvent(0)).data.payment_method, 'cod');
  assert.throws(() => normalizePaymentCollectedEvent({
    event_id: firstEventId,
    event: 'payment.collected',
    data: {
      payment_id: payments[0],
      amount: 100,
      currency: 'MMK',
      payment_method: 'card',
      collected_at: '2026-10-09T03:24:34.000Z',
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 100 }],
    },
  }));
  assert.throws(() => normalizePaymentCollectedEvent({
    event_id: firstEventId,
    event: 'payment.collected',
    data: {
      payment_id: payments[0],
      amount: Number.NaN,
      currency: '',
      payment_method: 'cod',
      collected_at: '2026-10-09T03:24:34.000Z',
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 100 }],
    },
  }));
});

test('COD collection must match COD payment, shop, and currency attribution', async () => {
  const missingProjection = createHarness();
  missingProjection.dependencies.getRevenueAllocations = async () => [];
  await assert.rejects(
    processPaymentCollected(collectedEvent(0), missingProjection.dependencies),
    /Order sales projection missing for collected COD payment/,
  );

  const nonCod = createHarness();
  nonCod.dependencies.getRevenueAllocations = async () => [{
    shop_id: 'shop-a',
    gross_amount: 100,
    shipping_total: 0,
    payment_id: payments[0],
    payment_status: 'PAID',
    currency: 'MMK',
  }];
  await assert.rejects(
    processPaymentCollected(collectedEvent(0), nonCod.dependencies),
    /does not match a COD order projection/,
  );

  const currencyMismatch = createHarness();
  currencyMismatch.dependencies.getRevenueAllocations = async () => [{
    shop_id: 'shop-a',
    gross_amount: 100,
    shipping_total: 0,
    payment_id: payments[0],
    payment_status: 'COD',
    currency: 'USD',
  }];
  await assert.rejects(
    processPaymentCollected(collectedEvent(0), currencyMismatch.dependencies),
    /currency does not match the order sales projection/,
  );

  const paymentMismatch = createHarness();
  paymentMismatch.dependencies.getRevenueAllocations = async () => [{
    shop_id: 'shop-a',
    gross_amount: 100,
    shipping_total: 0,
    payment_id: payments[1],
    payment_status: 'COD',
    currency: 'MMK',
  }];
  await assert.rejects(
    processPaymentCollected(collectedEvent(0), paymentMismatch.dependencies),
    /payment ID does not match the order projection/,
  );

  const shopMismatch = createHarness();
  shopMismatch.dependencies.getRevenueAllocations = async () => [{
    shop_id: 'shop-other',
    gross_amount: 100,
    shipping_total: 0,
    payment_id: payments[0],
    payment_status: 'COD',
    currency: 'MMK',
  }];
  await assert.rejects(
    processPaymentCollected(collectedEvent(0), shopMismatch.dependencies),
    /allocations do not match the order sales projection/,
  );

  assert.equal(isPermanentError(new Error(
    'COD payment allocation does not match the full order shop total',
  )), true);
});

test('order.paid accepts ORDER_PAID and does not recognize COD as collected income', () => {
  const paidEvent = orderPaidEvent('PAID');
  const codOrderEvent = orderPaidEvent('COD');

  assert.equal(paidEvent.data.status, 'ORDER_PAID');
  assert.equal(shouldRecognizeOrderPaidIncome(paidEvent), true);
  assert.equal(shouldRecognizeOrderPaidIncome(codOrderEvent), false);
});

test('order.paid posts COD receivable at order creation from authoritative per-shop totals', async () => {
  const upserted: Array<{ create: Record<string, unknown> }> = [];
  const recognized: Array<{ orderId: string; shopId: string; eventId: string; entryDate: Date }> = [];
  const tx = {
    pnlOrderShop: {
      findUnique: async () => null,
      upsert: async (input: { create: Record<string, unknown> }) => {
        upserted.push(input);
        return {};
      },
    },
  };
  const database = {
    $transaction: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
  } as unknown as Parameters<typeof processOrderPaid>[1];

  const event = orderPaidEvent('COD');
  const recorder = async (input: typeof recognized[number]) => { recognized.push(input); };
  await processOrderPaid(event, database, recorder);
  await processOrderPaid(event, database, recorder);

  assert.equal(upserted.length, 2);
  assert.equal(upserted[0]?.create.paymentStatus, 'COD');
  assert.equal(upserted[0]?.create.paymentId, payments[0]);
  assert.equal(upserted[0]?.create.paidAmount, 100);
  assert.deepEqual(recognized.map((row) => [row.orderId, row.shopId, row.eventId]), [
    [orders[0], 'shop-a', firstEventId],
    [orders[0], 'shop-a', firstEventId],
  ]);
});

test('order.paid refuses to overwrite conflicting COD projection totals', async () => {
  let upserts = 0;
  const tx = {
    pnlOrderShop: {
      findUnique: async () => ({
        paymentId: payments[0],
        paymentStatus: 'COD',
        shopOrderId: null,
        currency: 'MMK',
        grossItemSales: { toString: () => '100' },
        discountTotal: { toString: () => '0' },
        shippingTotal: { toString: () => '0' },
        paidAmount: { toString: () => '99' },
      }),
      upsert: async () => { upserts += 1; return {}; },
    },
  };
  const database = {
    $transaction: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
  } as unknown as Parameters<typeof processOrderPaid>[1];

  await assert.rejects(
    processOrderPaid(orderPaidEvent('COD'), database, async () => {}),
    /projection conflicts with order\.paid/,
  );
  assert.equal(upserts, 0);
});

test('COD order.paid requires payment identity, currency, and matching unique shop totals', () => {
  const event = orderPaidEvent('COD');
  assert.doesNotThrow(() => validateCodOrderPaidEvent(event));
  assert.throws(() => validateCodOrderPaidEvent({
    ...event,
    data: { ...event.data, payment_id: undefined },
  }), /requires payment_id, currency, and order amount/);
  assert.throws(() => validateCodOrderPaidEvent({
    ...event,
    data: {
      ...event.data,
      shop_breakdown: [
        ...event.data.shop_breakdown,
        { ...event.data.shop_breakdown[0]!, shop_id: 'shop-b' },
      ],
    },
  }), /shop totals do not match/);
  assert.throws(() => validateCodOrderPaidEvent({
    ...event,
    data: {
      ...event.data,
      shop_breakdown: [
        event.data.shop_breakdown[0]!,
        event.data.shop_breakdown[0]!,
      ],
      amount: 200,
    },
  }), /duplicate shop allocations/);
});

test('unsupported events and invalid payment statuses are permanent schema errors', () => {
  assert.throws(() => normalizePaymentEvent({
    event_id: firstEventId,
    event: 'payment.failed',
    data: {},
  }), (error: unknown) => isPermanentError(error));
  assert.throws(() => normalizePaymentCompletedEvent({
    event_id: firstEventId,
    event: 'payment.completed',
    data: {
      payment_id: payments[0],
      amount: 100,
      status: 'ORDER_PAID',
    },
  }));
  assert.throws(() => normalizeOrderPaidEvent({
    ...orderPaidEvent(),
    data: {
      ...orderPaidEvent().data,
      status: 'SUCCESS',
    },
  }));
});

function createHarness(options: { committedExpense?: boolean; failFirstSettlement?: boolean } = {}) {
  const paymentSettlements = new Map<string, {
    eventId: string;
    amount: number;
    allocations: Array<{ shop_id: string; gross_amount: number }>;
  }>();
  const bankReceipts = new Map<string, {
    referenceId: string;
    collectionReference: string;
    collectedAt: Date;
    orderId: string;
    shopId: string;
    amount: number;
    currency: string;
    lines: Array<{ accountCode: string; direction: string; amount: number }>;
  }>();
  const expenseOrderMembership = new Set(options.committedExpense ? orders : []);
  let expenseCount = options.committedExpense ? 1 : 0;
  let expenseJournalCount = options.committedExpense ? 1 : 0;
  let settlementAttempts = 0;

  const dependencies: PaymentCollectedProcessorDependencies = {
    getRevenueAllocations: async (orderId) => [{
      shop_id: 'shop-a',
      gross_amount: 100,
      shipping_total: 0,
      payment_id: payments[orders.indexOf(orderId)],
      payment_status: 'COD',
      currency: 'MMK',
    }],
    recordBatchExpense: async (input, eventId) => {
      if (expenseCount > 0) return;
      expenseCount = 1;
      expenseJournalCount = 1;
      input.orderIds.forEach((orderId) => expenseOrderMembership.add(orderId));
    },
    saveSettlement: async (input, allocations) => {
      settlementAttempts += 1;
      if (options.failFirstSettlement && settlementAttempts === 1) {
        throw new Error('simulated transient settlement failure');
      }
      const allocationsByShop = new Map<string, number>();
      for (const allocation of allocations) {
        allocationsByShop.set(
          allocation.shop_id!,
          (allocationsByShop.get(allocation.shop_id!) ?? 0) + allocation.gross_amount,
        );
      }
      paymentSettlements.set(input.paymentId, {
        eventId: input.eventId,
        amount: input.amount,
        allocations: [...allocationsByShop].map(([shop_id, gross_amount]) => ({ shop_id, gross_amount })),
      });
    },
    recordBankReceiptJournals: async (allocations, collectionReference) => {
      for (const allocation of allocations) {
        const key = `${allocation.paymentId}:${allocation.orderId}:${allocation.shopId}`;
        if (bankReceipts.has(key)) continue;
        bankReceipts.set(key, {
          referenceId: `${allocation.paymentId}:${allocation.shopId}`,
          collectionReference,
          collectedAt: allocation.collectedAt,
          orderId: allocation.orderId,
          shopId: allocation.shopId,
          amount: allocation.amount,
          currency: allocation.currency,
          lines: [
            { accountCode: '1010', direction: 'DEBIT', amount: allocation.amount },
            { accountCode: '1210', direction: 'CREDIT', amount: allocation.amount },
          ],
        });
      }
    },
  };

  return {
    dependencies,
    paymentSettlements,
    bankReceipts,
    expenseOrderMembership,
    get expenseCount() { return expenseCount; },
    get expenseJournalCount() { return expenseJournalCount; },
    get settlementAttempts() { return settlementAttempts; },
  };
}

test('creates one Stage 3 journal for each order allocation in a completed COD collection batch', async () => {
  const harness = createHarness({ committedExpense: true });

  for (let index = 0; index < orders.length; index += 1) {
    await processPaymentCollected(collectedEvent(index), harness.dependencies);
  }

  assert.equal(harness.paymentSettlements.size, 5);
  assert.equal(harness.bankReceipts.size, 5);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.deepEqual([...harness.expenseOrderMembership].sort(), [...orders].sort());
  for (const paymentId of payments) {
    assert.equal(harness.paymentSettlements.get(paymentId)?.amount, 100);
    assert.equal(harness.paymentSettlements.get(paymentId)?.allocations.length, 1);
  }
  for (let index = 0; index < orders.length; index += 1) {
    const receipt = harness.bankReceipts.get(`${payments[index]}:${orders[index]}:shop-a`);
    assert.equal(receipt?.referenceId, `${payments[index]}:shop-a`);
    assert.equal(receipt?.orderId, orders[index]);
    assert.equal(receipt?.amount, 100);
    assert.equal(receipt?.currency, 'MMK');
    assert.equal(receipt?.collectionReference, index === 0 ? firstEventId : `event-${index + 1}`);
    assert.equal(receipt?.collectedAt.toISOString(), '2026-10-09T03:24:34.000Z');
    assert.deepEqual(
      receipt?.lines.map((line) => [line.accountCode, line.direction, line.amount]),
      [['1010', 'DEBIT', 100], ['1210', 'CREDIT', 100]],
    );
  }
});

test('a fully processed duplicate COD event creates no additional records or allocations', async () => {
  const harness = createHarness({ committedExpense: true });
  const event = collectedEvent(0);

  await processPaymentCollected(event, harness.dependencies);
  const settlement = harness.paymentSettlements.get(payments[0]);
  const receipt = harness.bankReceipts.get(`${payments[0]}:${orders[0]}:shop-a`);
  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.bankReceipts.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.deepEqual(harness.paymentSettlements.get(payments[0]), settlement);
  assert.equal(harness.bankReceipts.get(`${payments[0]}:${orders[0]}:shop-a`), receipt);
});

test('republishing payment.collected with a new event ID does not duplicate its Stage 3 journal', async () => {
  const harness = createHarness();
  await processPaymentCollected(collectedEvent(0), harness.dependencies);
  await processPaymentCollected({
    ...collectedEvent(0),
    event_id: 'republished-payment-collected',
  }, harness.dependencies);

  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.bankReceipts.size, 1);
  assert.equal(harness.paymentSettlements.get(payments[0])?.eventId, 'republished-payment-collected');
});

test('a duplicate COD collected event creates its batch expense, settlement, and Stage 3 journal once', async () => {
  const harness = createHarness();
  const event = collectedEvent(0);

  await processPaymentCollected(event, harness.dependencies);
  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.bankReceipts.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
});

test('partial COD collection amounts are rejected and full collection is posted once', async () => {
  const harness = createHarness();
  const partial = collectedEvent(0);
  partial.event_id = 'partial-collection';
  partial.data.amount = 40;
  partial.data.shop_breakdown = [{ shop_id: 'shop-a', gross_amount: 40 }];
  await assert.rejects(
    processPaymentCollected(partial, harness.dependencies),
    /does not match the full order shop total/,
  );
  assert.equal(harness.paymentSettlements.size, 0);
  assert.equal(harness.bankReceipts.size, 0);

  const full = collectedEvent(0);
  await processPaymentCollected(full, harness.dependencies);
  await processPaymentCollected(full, harness.dependencies);

  assert.equal(harness.bankReceipts.size, 1);
  assert.equal(harness.paymentSettlements.get(payments[0])?.amount, 100);
  assert.equal(
    harness.paymentSettlements.get(payments[0])?.allocations[0]?.gross_amount,
    100,
  );
});

test('payment.collected creates a Stage 3 bank receipt from the successful collection amount', async () => {
  const harness = createHarness();
  await processPaymentCollected(collectedEvent(0), harness.dependencies);

  assert.equal(harness.paymentSettlements.get(payments[0])?.amount, 100);
  const receipt = harness.bankReceipts.get(`${payments[0]}:${orders[0]}:shop-a`);
  assert.equal(receipt?.amount, 100);
  assert.deepEqual(
    receipt?.lines.map((line) => [line.accountCode, line.direction]),
    [['1010', 'DEBIT'], ['1210', 'CREDIT']],
  );
});

test('order-paid income journal event IDs are operation-scoped and preserve existing journal IDs', () => {
  const orderPaidId = buildOrderPaidPaymentJournalEventId(payments[0], firstEventId);
  const collectedId = buildCollectedPaymentJournalEventId(payments[0], firstEventId);

  assert.notEqual(orderPaidId, firstEventId);
  assert.notEqual(orderPaidId, collectedId);
  assert.equal(resolvePaymentJournalEventId(firstEventId, orderPaidId), firstEventId);
  assert.equal(resolvePaymentJournalEventId(null, orderPaidId), orderPaidId);
});

test('a retry after settlement failure completes the missing collection projection', async () => {
  const harness = createHarness({ committedExpense: true, failFirstSettlement: true });
  const event = collectedEvent(0);

  await assert.rejects(
    processPaymentCollected(event, harness.dependencies),
    /simulated transient settlement failure/,
  );
  assert.equal(harness.bankReceipts.size, 0);
  assert.equal(harness.paymentSettlements.size, 0);

  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.bankReceipts.size, 1);
  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.equal(harness.settlementAttempts, 2);
  assert.equal(harness.paymentSettlements.get(payments[0])?.allocations.length, 1);
});
