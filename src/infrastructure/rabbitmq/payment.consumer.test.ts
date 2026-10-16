import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCollectedPaymentJournalEventId,
  buildOrderPaidPaymentJournalEventId,
  isPermanentError,
  normalizePaymentCollectedEvent,
  normalizePaymentEvent,
  processPaymentCollected,
  resolvePaymentJournalEventId,
  shouldRecognizeOrderPaidIncome,
  shouldRecognizePaymentEvent,
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

test('order.paid accepts ORDER_PAID and does not recognize COD as collected income', () => {
  const paidEvent = orderPaidEvent('PAID');
  const codOrderEvent = orderPaidEvent('COD');

  assert.equal(paidEvent.data.status, 'ORDER_PAID');
  assert.equal(shouldRecognizeOrderPaidIncome(paidEvent), true);
  assert.equal(shouldRecognizeOrderPaidIncome(codOrderEvent), false);
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
  const paymentJournals = new Map<string, { eventId: string; lines: unknown[] }>();
  const paymentSettlements = new Map<string, { eventId: string; amount: number; allocations: unknown[] }>();
  const journalEventIds = new Map<string, string>();
  const expenseOrderMembership = new Set(options.committedExpense ? orders : []);
  let expenseCount = options.committedExpense ? 1 : 0;
  let expenseJournalCount = options.committedExpense ? 1 : 0;
  let settlementAttempts = 0;

  if (options.committedExpense) {
    journalEventIds.set(firstEventId, 'EXPENSE:cod-batch');
  }

  const dependencies: PaymentCollectedProcessorDependencies = {
    isAlreadyProcessed: async (paymentId, eventId, journalEventId) =>
      paymentJournals.get(paymentId)?.eventId === journalEventId
      && paymentSettlements.get(paymentId)?.eventId === eventId,
    getRevenueAllocations: async () => [{
      shop_id: 'shop-a',
      gross_amount: 100,
      shipping_total: 0,
    }],
    recordBatchExpense: async (input, eventId) => {
      if (expenseCount > 0) return;
      expenseCount = 1;
      expenseJournalCount = 1;
      journalEventIds.set(eventId, 'EXPENSE:cod-batch');
      input.orderIds.forEach((orderId) => expenseOrderMembership.add(orderId));
    },
    saveJournal: async (input) => {
      const existingOwner = journalEventIds.get(input.eventId);
      assert.ok(
        existingOwner === undefined || existingOwner === `PAYMENT:${input.referenceId}`,
        `Journal event ID ${input.eventId} collides with ${existingOwner}`,
      );
      journalEventIds.set(input.eventId, `PAYMENT:${input.referenceId}`);
      paymentJournals.set(input.referenceId, { eventId: input.eventId, lines: input.lines });
    },
    saveSettlement: async (input, allocations) => {
      settlementAttempts += 1;
      if (options.failFirstSettlement && settlementAttempts === 1) {
        throw new Error('simulated transient settlement failure');
      }
      paymentSettlements.set(input.paymentId, {
        eventId: input.eventId,
        amount: input.amount,
        allocations,
      });
    },
  };

  return {
    dependencies,
    paymentJournals,
    paymentSettlements,
    expenseOrderMembership,
    get expenseCount() { return expenseCount; },
    get expenseJournalCount() { return expenseJournalCount; },
    get settlementAttempts() { return settlementAttempts; },
  };
}

test('accounts all five COD payments when the first event ID is already on the committed batch expense journal', async () => {
  const harness = createHarness({ committedExpense: true });

  for (let index = 0; index < orders.length; index += 1) {
    await processPaymentCollected(collectedEvent(index), harness.dependencies);
  }

  assert.equal(harness.paymentJournals.size, 5);
  assert.equal(harness.paymentSettlements.size, 5);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.deepEqual([...harness.expenseOrderMembership].sort(), [...orders].sort());
  assert.deepEqual(
    [...harness.paymentJournals.keys()].sort(),
    [...payments].sort(),
  );
  assert.equal(
    harness.paymentJournals.get(payments[0])?.eventId,
    buildCollectedPaymentJournalEventId(payments[0], firstEventId),
  );
  assert.notEqual(
    harness.paymentJournals.get(payments[0])?.eventId,
    firstEventId,
  );
  for (const paymentId of payments) {
    assert.equal(harness.paymentSettlements.get(paymentId)?.amount, 100);
    assert.equal(harness.paymentSettlements.get(paymentId)?.allocations.length, 1);
  }
});

test('a fully processed duplicate COD event creates no additional records or allocations', async () => {
  const harness = createHarness({ committedExpense: true });
  const event = collectedEvent(0);

  await processPaymentCollected(event, harness.dependencies);
  const journal = harness.paymentJournals.get(payments[0]);
  const settlement = harness.paymentSettlements.get(payments[0]);
  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.paymentJournals.size, 1);
  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.equal(harness.paymentJournals.get(payments[0]), journal);
  assert.equal(harness.paymentSettlements.get(payments[0]), settlement);
});

test('a duplicate COD collection creates its batch expense, income journal, and settlement only once', async () => {
  const harness = createHarness();
  const event = collectedEvent(0);

  await processPaymentCollected(event, harness.dependencies);
  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.paymentJournals.size, 1);
  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
});

test('order-paid income journal event IDs are operation-scoped and preserve existing journal IDs', () => {
  const orderPaidId = buildOrderPaidPaymentJournalEventId(payments[0], firstEventId);
  const collectedId = buildCollectedPaymentJournalEventId(payments[0], firstEventId);

  assert.notEqual(orderPaidId, firstEventId);
  assert.notEqual(orderPaidId, collectedId);
  assert.equal(resolvePaymentJournalEventId(firstEventId, orderPaidId), firstEventId);
  assert.equal(resolvePaymentJournalEventId(null, orderPaidId), orderPaidId);
});

test('a retry after the batch expense and payment journal commit completes the missing settlement', async () => {
  const harness = createHarness({ committedExpense: true, failFirstSettlement: true });
  const event = collectedEvent(0);

  await assert.rejects(
    processPaymentCollected(event, harness.dependencies),
    /simulated transient settlement failure/,
  );
  assert.equal(harness.paymentJournals.size, 1);
  assert.equal(harness.paymentSettlements.size, 0);

  await processPaymentCollected(event, harness.dependencies);

  assert.equal(harness.paymentJournals.size, 1);
  assert.equal(harness.paymentSettlements.size, 1);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
  assert.equal(harness.settlementAttempts, 2);
  assert.equal(harness.paymentSettlements.get(payments[0])?.allocations.length, 1);
});

test('a payment journal unique-key collision is propagated for retry rather than acknowledged as a duplicate', async () => {
  const harness = createHarness({ committedExpense: true });
  harness.dependencies.saveJournal = async () => {
    throw Object.assign(new Error('unique constraint violation'), {
      code: 'P2002',
      meta: { target: ['eventId'] },
    });
  };

  await assert.rejects(processPaymentCollected(collectedEvent(0), harness.dependencies), {
    code: 'P2002',
  });
  assert.equal(harness.paymentJournals.size, 0);
  assert.equal(harness.paymentSettlements.size, 0);
  assert.equal(harness.expenseCount, 1);
  assert.equal(harness.expenseJournalCount, 1);
});
