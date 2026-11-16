import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCodBankReceiptJournalLines,
  buildCodBankReceiptReferenceId,
  buildCodDeliveryCollectionJournalLines,
  buildCodDeliveryCollectionReferenceId,
  buildCodRevenueRecognitionJournalLines,
  buildCodRevenueReferenceId,
  recordCodBankReceiptJournals,
  recordCodDeliveryCollectionJournal,
  recordCodOrderRevenue,
} from './cod-lifecycle.service.js';
import { createJournalEntryInTransaction } from './services/entry.service.js';

const ORDER_ID = 'order-1';
const SHOP_ID = 'shop-1';
const PAYMENT_ID = 'payment-1';
const CURRENCY = 'MMK';
const AMOUNT = 125.5;
const SHIPPING_TOTAL = 25.5;
const amountCents = (value: { toString(): string } | number) =>
  Math.round(Number(value.toString()) * 100);

type MockJournal = {
  status: string;
  lines: Array<{
    account: { code: string };
    direction: string;
    amount: { toString(): string };
    currency: string | null;
    shopId: string | null;
  }>;
};

function createHarness(
  paymentStatus: string | null = 'COD',
  options: {
    projectionExists?: boolean;
    amount?: number;
    paymentId?: string | null;
    currency?: string | null;
  } = {},
) {
  const journals = new Map<string, MockJournal>();
  const journalInputs: Array<Parameters<typeof createJournalEntryInTransaction>[0]> = [];
  let writes = 0;
  const tx = {
    pnlOrderShop: {
      findUnique: async ({ where }: { where: { orderId_shopId: { orderId: string; shopId: string } } }) => {
        if (where.orderId_shopId.orderId !== ORDER_ID || where.orderId_shopId.shopId !== SHOP_ID) return null;
        if (options.projectionExists === false) return null;
        return {
          paymentId: options.paymentId === undefined ? PAYMENT_ID : options.paymentId,
          paymentStatus,
          currency: options.currency === undefined ? CURRENCY : options.currency,
          paidAmount: { toString: () => String(options.amount ?? AMOUNT) },
          shippingTotal: { toString: () => String(SHIPPING_TOTAL) },
        };
      },
    },
    journalEntry: {
      findUnique: async ({ where }: {
        where: { referenceType_referenceId: { referenceType: string; referenceId: string } };
      }) => journals.get(`${where.referenceType_referenceId.referenceType}:${where.referenceType_referenceId.referenceId}`) ?? null,
      findMany: async ({ where }: {
        where: { referenceType: string; referenceId: { startsWith: string }; status: string };
      }) => [...journals.entries()]
        .filter(([key, journal]) =>
          key.startsWith(`${where.referenceType}:`)
          && key.slice(where.referenceType.length + 1).startsWith(where.referenceId.startsWith)
          && journal.status === where.status,
        )
        .map(([, journal]) => journal),
    },
    $executeRaw: async () => 1,
  };
  const database = {
    $transaction: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
  } as unknown as Parameters<typeof recordCodOrderRevenue>[1];
  const journalCreator: typeof createJournalEntryInTransaction = async (input) => {
    writes += 1;
    journalInputs.push(input);
    journals.set(`${input.referenceType}:${input.referenceId}`, {
      status: 'POSTED',
      lines: input.lines.map((line) => ({
        account: { code: line.accountCode },
        direction: line.direction,
        amount: { toString: () => String(line.amount) },
        currency: line.currency ?? null,
        shopId: line.shopId ?? null,
      })),
    });
    return undefined as never;
  };

  return { database, journalCreator, journals, journalInputs, get writes() { return writes; } };
}

const revenueInput = {
  orderId: ORDER_ID,
  shopId: SHOP_ID,
  eventId: 'order-paid-event',
  entryDate: new Date('2026-10-17T00:00:00.000Z'),
};
const deliveryInput = {
  orderId: ORDER_ID,
  shopId: SHOP_ID,
  eventId: 'shipment-delivered-event',
  entryDate: new Date('2026-10-17T01:00:00.000Z'),
};
const bankAllocation = {
  orderId: ORDER_ID,
  shopId: SHOP_ID,
  paymentId: PAYMENT_ID,
  amount: AMOUNT,
  currency: CURRENCY,
  collectedAt: new Date('2026-10-17T02:00:00.000Z'),
  checkoutReference: 'checkout-1',
};

test('COD order revenue is posted once with the actual shop amount and currency', async () => {
  const harness = createHarness();

  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodOrderRevenue(
    { ...revenueInput, eventId: 'republished-order-paid-event' },
    harness.database,
    harness.journalCreator,
  );

  const journal = harness.journals.get(`COD_REVENUE:${buildCodRevenueReferenceId(ORDER_ID, SHOP_ID)}`);
  assert.equal(harness.writes, 1);
  assert.deepEqual(
    journal?.lines.map((line) => [line.account.code, line.direction, line.amount.toString(), line.currency, line.shopId]),
    [
      ['1200', 'DEBIT', '125.5', CURRENCY, SHOP_ID],
      ['4000', 'CREDIT', '125.5', CURRENCY, SHOP_ID],
    ],
  );
  assert.deepEqual(
    buildCodRevenueRecognitionJournalLines({
      orderId: ORDER_ID,
      shopId: SHOP_ID,
      amount: AMOUNT,
      currency: CURRENCY,
      shippingTotal: SHIPPING_TOTAL,
    }).map((line) => [line.accountCode, line.amount]),
    [['1200', AMOUNT], ['4000', AMOUNT]],
  );
});

test('shipment.delivered posts COD clearing against the receivable once, not revenue', async () => {
  const harness = createHarness();

  await assert.rejects(
    recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator),
    /revenue journal missing or inconsistent/,
  );
  assert.equal(harness.writes, 0);
  assert.equal(harness.journals.has(`COD_REVENUE:${buildCodRevenueReferenceId(ORDER_ID, SHOP_ID)}`), false);
  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal(
    { ...deliveryInput, eventId: 'redelivered-with-new-event-id' },
    harness.database,
    harness.journalCreator,
  );

  const journal = harness.journals.get(
    `COD_DELIVERY_COLLECTION:${buildCodDeliveryCollectionReferenceId(ORDER_ID, SHOP_ID)}`,
  );
  assert.equal(harness.writes, 2);
  assert.equal([...harness.journals.keys()].filter((key) => key.startsWith('COD_REVENUE:')).length, 1);
  assert.equal([...harness.journals.keys()].filter((key) => key.startsWith('COD_DELIVERY_COLLECTION:')).length, 1);
  const revenue = harness.journals.get(`COD_REVENUE:${buildCodRevenueReferenceId(ORDER_ID, SHOP_ID)}`);
  assert.deepEqual(
    revenue?.lines.map((line) => [line.account.code, line.direction, line.amount.toString()]),
    [['1200', 'DEBIT', '125.5'], ['4000', 'CREDIT', '125.5']],
  );
  assert.equal(
    revenue?.lines.reduce((debits, line) => debits + (line.direction === 'DEBIT' ? amountCents(line.amount) : 0), 0),
    revenue?.lines.reduce((credits, line) => credits + (line.direction === 'CREDIT' ? amountCents(line.amount) : 0), 0),
  );
  assert.deepEqual(
    journal?.lines.map((line) => [line.account.code, line.direction, line.amount.toString(), line.currency, line.shopId]),
    [['1210', 'DEBIT', '125.5', CURRENCY, SHOP_ID], ['1200', 'CREDIT', '125.5', CURRENCY, SHOP_ID]],
  );
  assert.equal(
    journal?.lines.reduce((debits, line) => debits + (line.direction === 'DEBIT' ? amountCents(line.amount) : 0), 0),
    journal?.lines.reduce((credits, line) => credits + (line.direction === 'CREDIT' ? amountCents(line.amount) : 0), 0),
  );
  assert.deepEqual(
    buildCodDeliveryCollectionJournalLines({
      orderId: ORDER_ID,
      shopId: SHOP_ID,
      amount: AMOUNT,
      currency: CURRENCY,
    }).map((line) => line.accountCode),
    ['1210', '1200'],
  );
});

test('delivery collection uses an explicit partial amount and preserves delivery metadata', async () => {
  const harness = createHarness();

  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal({
    ...deliveryInput,
    amount: 10,
    deliveryProviderId: 'provider-1',
    deliveryId: 'delivery-1',
    deliveryNumber: 'DLV-1',
    waybill: 'WB-1',
    eventReference: 'delivery-event-1',
  }, harness.database, harness.journalCreator);

  const journal = harness.journalInputs.find((entry) => entry.referenceType === 'COD_DELIVERY_COLLECTION');
  assert.deepEqual(
    journal?.lines.map((line) => [line.accountCode, line.direction, line.amount, line.shopId]),
    [['1210', 'DEBIT', 10, SHOP_ID], ['1200', 'CREDIT', 10, SHOP_ID]],
  );
  assert.match(journal?.narration ?? '', /Delivered — COD in Transit \(Assumed Collection\)/);
  assert.match(journal?.narration ?? '', /courier cash receipt not independently verified/);
  assert.match(journal?.narration ?? '', /payment=payment-1/);
  assert.match(journal?.narration ?? '', /deliveryProvider=provider-1/);
  assert.match(journal?.narration ?? '', /delivery=delivery-1/);
  assert.match(journal?.narration ?? '', /waybill=WB-1/);
  assert.match(journal?.narration ?? '', /event=delivery-event-1/);
});

test('delivery collection rejects invalid amounts and missing attribution', async () => {
  const harness = createHarness();
  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);

  for (const amount of [0, -1, AMOUNT + 1, Number.NaN]) {
    await assert.rejects(
      recordCodDeliveryCollectionJournal({ ...deliveryInput, amount }, harness.database, harness.journalCreator),
      /invalid payable amount/,
    );
  }
  await assert.rejects(
    recordCodDeliveryCollectionJournal({ ...deliveryInput, shopId: 'unknown-shop' }, harness.database, harness.journalCreator),
    /Order sales projection missing/,
  );
  await assert.rejects(
    recordCodDeliveryCollectionJournal(deliveryInput, createHarness('COD', { projectionExists: false }).database, harness.journalCreator),
    /Order sales projection missing/,
  );
  await assert.rejects(
    recordCodDeliveryCollectionJournal(
      deliveryInput,
      createHarness('COD', { paymentId: null }).database,
      harness.journalCreator,
    ),
    /no payment or currency attribution/,
  );
  assert.equal(harness.writes, 1);
});

test('successful payment.collected posts an idempotent Stage 3 journal after delivery collection', async () => {
  const harness = createHarness();

  await assert.rejects(
    recordCodBankReceiptJournals([bankAllocation], 'collected-early', harness.database, harness.journalCreator),
    /before delivery collection/,
  );
  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator);
  await recordCodBankReceiptJournals([bankAllocation], 'payment-collected-event', harness.database, harness.journalCreator);
  await recordCodBankReceiptJournals([bankAllocation], 'duplicate-event-id', harness.database, harness.journalCreator);

  const journal = harness.journals.get(
    `COD_BANK_RECEIPT:${buildCodBankReceiptReferenceId(PAYMENT_ID, SHOP_ID)}`,
  );
  assert.equal(harness.writes, 3);
  assert.deepEqual(
    journal?.lines.map((line) => [line.account.code, line.direction, line.amount.toString(), line.currency, line.shopId]),
    [['1010', 'DEBIT', '125.5', CURRENCY, SHOP_ID], ['1210', 'CREDIT', '125.5', CURRENCY, SHOP_ID]],
  );
  const journalInput = harness.journalInputs.find((entry) => entry.referenceType === 'COD_BANK_RECEIPT');
  assert.equal(journalInput?.entryDate?.toString(), bankAllocation.collectedAt.toString());
  assert.match(journalInput?.narration ?? '', /order order-1, shop shop-1/);
  assert.match(journalInput?.narration ?? '', /collection_ref=payment-collected-event/);
  assert.match(journalInput?.narration ?? '', /collected_at=2026-10-17T02:00:00.000Z/);
  assert.match(journalInput?.narration ?? '', /checkout_ref=checkout-1/);
  assert.deepEqual(
    buildCodBankReceiptJournalLines(bankAllocation).map((line) => line.accountCode),
    ['1010', '1210'],
  );
});

test('COD lifecycle rejects bank receipt amount, currency, payment, and shop mismatches', async () => {
  const harness = createHarness();
  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator);

  await assert.rejects(
    recordCodBankReceiptJournals([{ ...bankAllocation, amount: AMOUNT - 1 }], 'wrong-amount', harness.database, harness.journalCreator),
    /amount does not match/,
  );
  await assert.rejects(
    recordCodBankReceiptJournals([{ ...bankAllocation, currency: 'USD' }], 'wrong-currency', harness.database, harness.journalCreator),
    /attribution conflicts/,
  );
  await assert.rejects(
    recordCodBankReceiptJournals([{ ...bankAllocation, paymentId: 'other-payment' }], 'wrong-payment', harness.database, harness.journalCreator),
    /attribution conflicts/,
  );
  await assert.rejects(
    recordCodBankReceiptJournals([{ ...bankAllocation, shopId: 'other-shop' }], 'wrong-shop', harness.database, harness.journalCreator),
    /Order sales projection missing/,
  );
  assert.equal(harness.writes, 2);
});

test('non-COD orders do not receive COD revenue or delivery collection journals', async () => {
  const harness = createHarness('PAID');

  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator);

  assert.equal(harness.writes, 0);
});

test('missing payment status is rejected instead of treated as COD', async () => {
  const harness = createHarness(null);
  await assert.rejects(
    recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator),
    /lacks payment status/,
  );
});
