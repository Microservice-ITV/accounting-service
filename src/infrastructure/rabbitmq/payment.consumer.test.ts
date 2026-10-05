import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCollectedPaymentJournalLines,
  buildMerchandisePaymentJournalLines,
  buildPaymentJournalLines,
  buildSellerSettlementJournalLines,
  buildPnlOrderShopProjections,
  buildOrderDeliveryExpenses,
  normalizeOrderPaidEvent,
  normalizePaymentCollectedEvent,
  normalizePaymentCompletedEvent,
  shouldRecognizeCompletedPayment,
  shouldRecognizePaymentEvent,
} from './payment.consumer.js';

test('normalizePaymentCompletedEvent accepts shop and order metadata in payment.completed', () => {
  const event = normalizePaymentCompletedEvent({
    event_id: 'evt-1',
    event: 'payment.completed',
    data: {
      payment_id: 'pay-1',
      order_id: 'order-101',
      checkout_id: 'checkout-101',
      amount: 150,
      currency: 'MMK',
      shop_id: 'shop-42',
      seller_id: 'seller-99',
      shop_breakdown: [
        { shop_id: 'shop-42', seller_id: 'seller-99', gross_amount: 150, net_payout: 150 },
      ],
    },
  });

  assert.equal(event.data.order_id, 'order-101');
  assert.equal(event.data.shop_id, 'shop-42');
  assert.equal(event.data.seller_id, 'seller-99');
  assert.equal(event.data.shop_breakdown?.[0].net_payout, 150);
});

test('COD payment.completed is deferred until physical collection', () => {
  const event = normalizePaymentCompletedEvent({
    event_id: 'evt-cod-completed',
    event: 'payment.completed',
    data: {
      payment_id: 'pay-cod',
      amount: 100,
      payment_method: 'COD',
    },
  });

  assert.equal(shouldRecognizeCompletedPayment(event), false);
});

test('non-COD payment.completed is recognized as actual income', () => {
  const event = normalizePaymentCompletedEvent({
    event_id: 'evt-card-completed',
    event: 'payment.completed',
    data: {
      payment_id: 'pay-card',
      amount: 100,
      payment_method: 'card',
    },
  });

  assert.equal(shouldRecognizeCompletedPayment(event), true);
});

test('COD payment.collected is recognized after collection', () => {
  const event = normalizePaymentCollectedEvent({
    event_id: 'evt-cod-collected',
    event: 'payment.collected',
    data: {
      payment_id: 'pay-cod-collected',
      amount: 100,
      payment_method: 'COD',
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 100 }],
    },
  });

  assert.equal(shouldRecognizePaymentEvent(event), true);
});

test('order.paid projection persists shop-level item sales and distinguishes funding and discount types', () => {
  const event = normalizeOrderPaidEvent({
    event_id: 'evt-order-paid',
    event: 'order.paid',
    timestamp: '2026-06-15T12:00:00.000Z',
    data: {
      order_id: 'order-pnl',
      payment_id: 'pay-pnl',
      currency: 'MMK',
      shop_breakdown: [
        {
          shop_id: 'shop-a',
          shop_order_id: 'shop-order-a',
          subtotal: 100,
          discount_total: 20,
          shipping_total: 10,
          grand_total: 90,
        },
        {
          shop_id: 'shop-b',
          shop_order_id: 'shop-order-b',
          subtotal: 50,
          discount_total: 0,
          shipping_total: 5,
          grand_total: 55,
        },
      ],
      promotion_allocations: [
        { shop_id: 'shop-a', discount_type: 'ITEM', funded_by: 'SELLER', amount: 10 },
        { shop_id: 'shop-a', discount_type: 'ITEM', funded_by: 'PLATFORM', amount: 5 },
        { shop_id: 'shop-a', discount_type: 'SHIPPING', funded_by: 'SELLER', amount: 3 },
        { shop_id: 'shop-a', discount_type: 'SHIPPING', funded_by: 'PLATFORM', amount: 2 },
      ],
    },
  });
  const projections = buildPnlOrderShopProjections(event);

  assert.equal(projections.length, 2);
  assert.equal(projections[0].shopId, 'shop-a');
  assert.equal(projections[0].grossItemSales, 100);
  assert.equal(projections[0].paidAmount, 90);
  assert.equal(projections[0].discountAllocationsComplete, true);
  assert.deepEqual(
    projections[0].discounts.map(({ discountType, fundedBy }) => [discountType, fundedBy]),
    [
      ['ITEM', 'SELLER'],
      ['ITEM', 'PLATFORM'],
      ['SHIPPING', 'SELLER'],
      ['SHIPPING', 'PLATFORM'],
    ],
  );
  assert.equal(projections[1].shopId, 'shop-b');
  assert.equal(projections[1].grossItemSales, 50);
  assert.equal(projections[1].discountAllocationsComplete, true);
});

test('order.paid creates one fixed MMK Deli expense reference per shop order', () => {
  const event = normalizeOrderPaidEvent({
    event_id: 'evt-delivery-expense',
    event: 'order.paid',
    timestamp: '2026-10-05T10:00:00.000Z',
    data: {
      order_id: 'order-delivery',
      currency: 'MMK',
      shop_breakdown: [
        { shop_id: 'shop-a', shop_order_id: 'shop-order-a', subtotal: 1000, grand_total: 1000 },
        { shop_id: 'shop-b', shop_order_id: 'shop-order-b', subtotal: 2000, grand_total: 2000 },
      ],
    },
  });
  const expenses = buildOrderDeliveryExpenses(event);

  assert.equal(expenses.length, 2);
  assert.deepEqual(
    expenses.map(({ expenseNo, shopId, amount, currency }) => ({ expenseNo, shopId, amount, currency })),
    [
      { expenseNo: 'DELI-shop-order-a', shopId: 'shop-a', amount: 300, currency: 'MMK' },
      { expenseNo: 'DELI-shop-order-b', shopId: 'shop-b', amount: 300, currency: 'MMK' },
    ],
  );
  assert.equal(expenses[0].expenseDate.toISOString(), '2026-10-05T10:00:00.000Z');
});

test('buildPaymentJournalLines keeps cash/revenue accounting while including shop context in memo', () => {
  const lines = buildPaymentJournalLines({
    payment_id: 'pay-2',
    order_id: 'order-202',
    amount: 200,
    currency: 'USD',
    shop_id: 'shop-88',
    seller_id: 'seller-77',
  });

  assert.equal(lines.length, 2);
  assert.equal(lines[0].accountCode, '1000');
  assert.equal(lines[0].direction, 'DEBIT');
  assert.equal(lines[0].amount, 200);
  assert.equal(lines[1].accountCode, '4000');
  assert.equal(lines[1].direction, 'CREDIT');
  assert.match(lines[0].memo ?? '', /shop-88|seller-77|order-202/);
});

test('seller settlement metadata does not create a second cash debit', () => {
  const lines = buildSellerSettlementJournalLines({
    payment_id: 'pay-3',
    order_id: 'order-303',
    amount: 60000,
    currency: 'USD',
    shop_breakdown: [
      { shop_id: 'shop-a', seller_id: 'seller-a', gross_amount: 60000, net_payout: 60000 },
      { shop_id: 'shop-b', seller_id: 'seller-b', gross_amount: 40000, net_payout: 40000 },
    ],
  });

  assert.equal(lines, null);
});

test('normalizePaymentCollectedEvent accepts COD allocations', () => {
  const event = normalizePaymentCollectedEvent({
    event_id: 'evt-collected-1',
    event: 'payment.collected',
    data: {
      payment_id: 'pay-cod-1',
      order_id: 'order-404',
      checkout_id: 'checkout-404',
      amount: 100000,
      currency: 'MMK',
      payment_method: 'cod',
      shop_breakdown: [
        { shop_id: 'shop-a', gross_amount: 60000 },
        { shop_id: 'shop-b', gross_amount: 40000 },
      ],
    },
  });

  assert.equal(event.data.shop_breakdown[0].shop_id, 'shop-a');
  assert.equal(event.data.shop_breakdown[1].gross_amount, 40000);
});

test('collected COD journal lines allocate revenue per shop and balance cash', () => {
  const lines = buildCollectedPaymentJournalLines({
    payment_id: 'pay-cod-2',
    order_id: 'order-505',
    amount: 100000,
    currency: 'MMK',
  }, [
    { shop_id: 'shop-a', gross_amount: 60000, shipping_total: 12000 },
    { shop_id: 'shop-b', gross_amount: 40000, shipping_total: 8000 },
  ]);

  assert.equal(lines.length, 5);
  assert.equal(lines[0].accountCode, '1000');
  assert.equal(lines[0].direction, 'DEBIT');
  assert.equal(lines[0].amount, 100000);
  assert.deepEqual(lines.filter((line) => line.accountCode === '4000').map((line) => line.amount), [48000, 32000]);
  assert.deepEqual(lines.filter((line) => line.accountCode === '2000').map((line) => line.amount), [12000, 8000]);
  assert.match(lines[1].memo ?? '', /shop=shop-a/);
  assert.match(lines[2].memo ?? '', /shop=shop-b/);
  assert.equal(
    lines.filter((line) => line.direction === 'DEBIT').reduce((sum, line) => sum + line.amount, 0),
    lines.filter((line) => line.direction === 'CREDIT').reduce((sum, line) => sum + line.amount, 0),
  );
});

test('COD and online order journals recognize merchandise only and retain shipping as payable', () => {
  const context = {
    payment_id: 'pay-cod-shipping',
    order_id: 'order-shipping',
    amount: 7075.88,
    currency: 'MMK',
  };
  const allocations = [{
    shop_id: 'shop-a',
    gross_amount: 7075.88,
    shipping_total: 1575.88,
  }];

  for (const lines of [
    buildCollectedPaymentJournalLines(context, allocations),
    buildMerchandisePaymentJournalLines(context, allocations, 'Payment received'),
  ]) {
    assert.equal(lines[0].accountCode, '1000');
    assert.equal(lines[0].amount, 7075.88);
    assert.deepEqual(
      lines.filter((line) => line.accountCode === '4000').map((line) => line.amount),
      [5500],
    );
    assert.deepEqual(
      lines.filter((line) => line.accountCode === '2000').map((line) => line.amount),
      [1575.88],
    );
    assert.equal(
      lines.filter((line) => line.direction === 'DEBIT').reduce((sum, line) => sum + line.amount, 0),
      lines.filter((line) => line.direction === 'CREDIT').reduce((sum, line) => sum + line.amount, 0),
    );
  }
});

test('collected COD journal rejects missing or mismatched allocations', () => {
  assert.throws(
    () => buildCollectedPaymentJournalLines({ payment_id: 'pay-3', amount: 100 }, []),
    /requires shop allocations/,
  );
  assert.throws(
    () => buildCollectedPaymentJournalLines({
      payment_id: 'pay-4',
      amount: 100,
    }, [{ shop_id: 'shop-a', gross_amount: 90, shipping_total: 0 }]),
    /does not match payment amount/,
  );
});
