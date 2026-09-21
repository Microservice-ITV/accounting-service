import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaymentJournalLines,
  buildSellerSettlementJournalLines,
  normalizePaymentCompletedEvent,
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
