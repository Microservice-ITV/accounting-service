import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCollectedPaymentJournalLines,
  buildPaymentJournalLines,
  buildSellerSettlementJournalLines,
  normalizePaymentCollectedEvent,
  normalizePaymentCompletedEvent,
  shouldRecognizeCompletedPayment,
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
    shop_breakdown: [
      { shop_id: 'shop-a', gross_amount: 60000 },
      { shop_id: 'shop-b', gross_amount: 40000 },
    ],
  });

  assert.equal(lines.length, 3);
  assert.equal(lines[0].accountCode, '1000');
  assert.equal(lines[0].direction, 'DEBIT');
  assert.equal(lines[0].amount, 100000);
  assert.deepEqual(lines.slice(1).map((line) => line.amount), [60000, 40000]);
  assert.match(lines[1].memo ?? '', /shop=shop-a/);
  assert.match(lines[2].memo ?? '', /shop=shop-b/);
  assert.equal(
    lines.filter((line) => line.direction === 'DEBIT').reduce((sum, line) => sum + line.amount, 0),
    lines.filter((line) => line.direction === 'CREDIT').reduce((sum, line) => sum + line.amount, 0),
  );
});

test('collected COD journal rejects missing or mismatched allocations', () => {
  assert.throws(
    () => buildCollectedPaymentJournalLines({ payment_id: 'pay-3', amount: 100, shop_breakdown: [] }),
    /requires shop allocations/,
  );
  assert.throws(
    () => buildCollectedPaymentJournalLines({
      payment_id: 'pay-4',
      amount: 100,
      shop_breakdown: [{ shop_id: 'shop-a', gross_amount: 90 }],
    }),
    /does not match payment amount/,
  );
});
