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

function createHarness(paymentStatus: string | null = 'COD') {
  const journals = new Map<string, MockJournal>();
  let writes = 0;
  const tx = {
    pnlOrderShop: {
      findUnique: async ({ where }: { where: { orderId_shopId: { orderId: string; shopId: string } } }) => {
        if (where.orderId_shopId.orderId !== ORDER_ID || where.orderId_shopId.shopId !== SHOP_ID) return null;
        return {
          paymentId: PAYMENT_ID,
          paymentStatus,
          currency: CURRENCY,
          paidAmount: { toString: () => String(AMOUNT) },
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

  return { database, journalCreator, journals, get writes() { return writes; } };
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
};

test('COD order revenue is posted once with the actual shop amount and currency', async () => {
  const harness = createHarness();

  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);
  await recordCodOrderRevenue(revenueInput, harness.database, harness.journalCreator);

  const journal = harness.journals.get(`COD_REVENUE:${buildCodRevenueReferenceId(ORDER_ID, SHOP_ID)}`);
  assert.equal(harness.writes, 1);
  assert.deepEqual(
    journal?.lines.map((line) => [line.account.code, line.direction, line.amount.toString(), line.currency, line.shopId]),
    [
      ['1200', 'DEBIT', '125.5', CURRENCY, SHOP_ID],
      ['4000', 'CREDIT', '100', CURRENCY, SHOP_ID],
      ['2000', 'CREDIT', '25.5', CURRENCY, SHOP_ID],
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
    [['1200', AMOUNT], ['4000', AMOUNT - SHIPPING_TOTAL], ['2000', SHIPPING_TOTAL]],
  );
});

test('shipment.delivered posts COD clearing against the receivable once, not revenue', async () => {
  const harness = createHarness();

  await assert.rejects(
    recordCodDeliveryCollectionJournal(deliveryInput, harness.database, harness.journalCreator),
    /revenue journal missing or inconsistent/,
  );
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
  assert.deepEqual(
    journal?.lines.map((line) => [line.account.code, line.direction, line.amount.toString(), line.currency, line.shopId]),
    [['1210', 'DEBIT', '125.5', CURRENCY, SHOP_ID], ['1200', 'CREDIT', '125.5', CURRENCY, SHOP_ID]],
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

test('payment.collected posts a bank receipt only after delivery collection and is idempotent', async () => {
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
