import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildDeliveryExpenseReference,
  buildShipmentDeliveredExpense,
  normalizeShipmentDeliveredEvent,
  PermanentShipmentDeliveredEventError,
  recordShipmentDeliveredExpenses,
  selectApplicableDeliveryFee,
} from './shipment-delivered.consumer.js';
import type { ShipmentDeliveredEvent } from './shipment-delivered.consumer.js';
import { createJournalEntryInTransaction } from '../../modules/entries/entry.service.js';

const PER_ORDER_PROVIDER_ID = randomUUID();
const PER_DAY_PROVIDER_ID = randomUUID();

const makeEvent = (
  providerId: string | null = PER_ORDER_PROVIDER_ID,
  shopIds: Array<string | null> = ['shop-1'],
  deliveryId = 'delivery-1',
  orderId = 'order-1',
  deliveredAt = '2026-10-07T01:00:00.000Z',
  customerDeliveryFee?: number,
) => normalizeShipmentDeliveredEvent({
  event_id: `delivered-event-${deliveryId}`,
  event: 'shipment.delivered',
  version: 'v1',
  timestamp: '2026-10-07T01:00:00.000Z',
  delivery_id: deliveryId,
  data: {
    order_id: orderId,
    ...(providerId ? { provider_id: providerId } : {}),
    shop_id: shopIds.length === 1 ? shopIds[0] : undefined,
    ...(customerDeliveryFee === undefined ? {} : { shipping_fee: customerDeliveryFee }),
    delivery_id: deliveryId,
    delivery: {
      deliveryId,
      deliveryNumber: `DLV-${deliveryId}`,
      ...(providerId ? { providerId } : {}),
      shopId: shopIds.length === 1 ? shopIds[0] : undefined,
      courier: { code: 'UNTRUSTED-CODE', name: 'Customer-facing label', phone: '' },
      status: 'DELIVERED',
      timeline: {
        createdAt: '2026-10-06T01:00:00.000Z',
        shippedAt: '2026-10-06T02:00:00.000Z',
        outForDeliveryAt: '2026-10-07T00:00:00.000Z',
        deliveredAt,
        failedAt: null,
      },
      items: shopIds.map((shopId) => ({ productId: 'product-1', shopId, quantity: 1 })),
    },
  },
});

type Fee = {
  id: string;
  providerId: string;
  chargingBasis: 'PER_ORDER' | 'PER_DAY';
  amount: Prisma.Decimal;
  currency: string;
  active: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdAt: Date;
};

function createDatabase(fees: Fee[]) {
  const expenses = new Map<string, Record<string, unknown>>();
  const journalReferences = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const feeLookups: string[] = [];
  let expenseCreateCount = 0;
  const journalAmounts: number[][] = [];
  const tx = {
    deliveryProviderFee: {
      findMany: async ({ where }: { where: { providerId: string } }) => {
        feeLookups.push(where.providerId);
        return fees.filter((candidate) => candidate.providerId === where.providerId);
      },
    },
    expense: {
      findUnique: async ({ where }: { where: { expenseNo: string } }) =>
        expenses.get(where.expenseNo) ?? null,
      findFirst: async ({ where }: { where: { expenseNo: { in: string[] } } }) =>
        [...where.expenseNo.in]
          .map((expenseNo) => expenses.get(expenseNo))
          .find((expense) => expense !== undefined) ?? null,
      upsert: async (args: {
        where: { expenseNo: string };
        create: Record<string, unknown>;
      }) => {
        const existing = expenses.get(args.where.expenseNo);
        if (existing) return existing;
        expenseCreateCount += 1;
        expenses.set(args.where.expenseNo, args.create);
        return args.create;
      },
    },
    expenseCategory: {
      upsert: async () => ({ id: 'delivery-category' }),
    },
    journalEntry: {
      findFirst: async (args: { where: { referenceType: string; referenceId: string } }) =>
        journalReferences.has(args.where.referenceId) ? { id: 'journal-1' } : null,
    },
  };
  const database = {
    $transaction: async (work: (transaction: unknown) => Promise<void>) => {
      const releases: Array<() => void> = [];
      const transaction = {
        ...tx,
        $executeRaw: async (_strings: TemplateStringsArray, reference: string) => {
          const previousLock = locks.get(reference);
          let release = () => {};
          const lock = new Promise<void>((resolve) => {
            release = resolve;
          });
          locks.set(reference, lock);
          if (previousLock) await previousLock;
          releases.push(() => {
            release();
            if (locks.get(reference) === lock) locks.delete(reference);
          });
          return 1;
        },
      };

      try {
        return await work(transaction as unknown as Prisma.TransactionClient);
      } finally {
        releases.reverse().forEach((release) => release());
      }
    },
  } as unknown as Pick<PrismaClient, '$transaction'>;
  const journalCreator: typeof createJournalEntryInTransaction = async (input) => {
    journalReferences.add(input.referenceId);
    journalAmounts.push(input.lines.map((line) => line.amount));
    return undefined as never;
  };

  return {
    database,
    journalCreator,
    expenses,
    feeLookups,
    get expenseCreateCount() { return expenseCreateCount; },
    get journalCreateCount() { return journalAmounts.length; },
    get journalAmounts() { return journalAmounts; },
  };
}

const fee = (
  id: string,
  providerId: string,
  amount: string,
  effectiveFrom: string | null = null,
  chargingBasis: Fee['chargingBasis'] = 'PER_ORDER',
  effectiveTo: string | null = null,
): Fee => ({
  id,
  providerId,
  chargingBasis,
  amount: new Prisma.Decimal(amount),
  currency: 'MMK',
  active: true,
  effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
  effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

const expenseTotal = (expenses: Map<string, Record<string, unknown>>) =>
  [...expenses.values()].reduce((total, expense) => total + Number(expense.amount), 0);

test('reads the actual Delivery Service provider and shop fields without requiring invoiceId', () => {
  const expense = buildShipmentDeliveredExpense(makeEvent());

  assert.equal(expense.providerId, PER_ORDER_PROVIDER_ID);
  assert.equal(expense.orderId, 'order-1');
  assert.equal(expense.deliveryId, 'delivery-1');
  assert.equal(expense.deliveryNumber, 'DLV-delivery-1');
  assert.equal(expense.shopId, 'shop-1');
  assert.equal(expense.expenseDate.toISOString(), '2026-10-07T01:00:00.000Z');
  assert.equal('invoiceId' in expense, false);
});

test('looks up the configured fee directly by Delivery Service providerId', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  await recordShipmentDeliveredExpenses(makeEvent(), harness.database, harness.journalCreator);

  assert.deepEqual(harness.feeLookups, [PER_ORDER_PROVIDER_ID]);
  assert.equal([...harness.expenses.values()][0]?.deliveryProviderId, PER_ORDER_PROVIDER_ID);
});

test('selects the most recent effective fee at the delivered time', () => {
  const selected = selectApplicableDeliveryFee([
    fee('current', PER_ORDER_PROVIDER_ID, '320.00', '2026-10-01T00:00:00.000Z'),
    fee('future', PER_ORDER_PROVIDER_ID, '350.00', '2026-11-01T00:00:00.000Z'),
    fee('default', PER_ORDER_PROVIDER_ID, '300.00'),
  ], new Date('2026-10-07T01:00:00.000Z'));

  assert.equal(selected?.id, 'current');
});

test('selects fees within their effective date range', () => {
  const selected = selectApplicableDeliveryFee([
    fee('expired', PER_ORDER_PROVIDER_ID, '280.00', '2026-09-01T00:00:00.000Z', 'PER_ORDER', '2026-10-01T00:00:00.000Z'),
    fee('current', PER_ORDER_PROVIDER_ID, '300.00', '2026-10-01T00:00:00.000Z', 'PER_ORDER', '2026-11-01T00:00:00.000Z'),
  ], new Date('2026-10-07T01:00:00.000Z'));

  assert.equal(selected?.id, 'current');
});

test('does not create an expense or journal for an unknown providerId', async () => {
  const harness = createDatabase([fee('per-day-fee', PER_DAY_PROVIDER_ID, '300.00', null, 'PER_DAY')]);

  await assert.rejects(
    recordShipmentDeliveredExpenses(makeEvent('unknown-delivery-provider-id'), harness.database, harness.journalCreator),
    /No active delivery fee applies to provider ID unknown-delivery-provider-id/
  );
  assert.equal(harness.expenseCreateCount, 0);
  assert.equal(harness.journalCreateCount, 0);
});

test('does not create expenses for deliveries with multiple distinct shop IDs', async () => {
  const event = makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1', 'shop-2']);
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  assert.throws(() => buildShipmentDeliveredExpense(event), PermanentShipmentDeliveredEventError);
  await assert.rejects(
    recordShipmentDeliveredExpenses(event, harness.database, harness.journalCreator),
    /contains multiple shops/
  );
  assert.equal(harness.expenseCreateCount, 0);
  assert.equal(harness.journalCreateCount, 0);
});

test('rejects missing or conflicting Delivery Service provider IDs', () => {
  assert.throws(
    () => buildShipmentDeliveredExpense(makeEvent(null)),
    /missing the Delivery Service provider ID/
  );

  const conflicting = makeEvent();
  conflicting.data.delivery.providerId = PER_DAY_PROVIDER_ID;
  assert.throws(
    () => buildShipmentDeliveredExpense(conflicting),
    /contains conflicting provider IDs/
  );
});

test('rejects invalid delivered timestamps and missing shop attribution', () => {
  const invalidDate = makeEvent();
  invalidDate.data.delivery.timeline.deliveredAt = 'not-a-date';
  assert.throws(() => buildShipmentDeliveredExpense(invalidDate), /invalid .*deliveredAt/);

  const missingShop = makeEvent(PER_ORDER_PROVIDER_ID, [null]);
  missingShop.data.shop_id = undefined;
  missingShop.data.delivery.shopId = undefined;
  assert.throws(
    () => buildShipmentDeliveredExpense(missingShop),
    /no complete item shop attribution/
  );
});

test('repeated delivered events create one expense and one journal entry', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);
  const event: ShipmentDeliveredEvent = makeEvent();

  await Promise.all([
    recordShipmentDeliveredExpenses(event, harness.database, harness.journalCreator),
    recordShipmentDeliveredExpenses(event, harness.database, harness.journalCreator),
  ]);

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(harness.journalCreateCount, 1);
  assert.deepEqual(harness.journalAmounts, [[300, 300]]);
});

test('separate delivery events for the same order do not create a second order charge', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  await recordShipmentDeliveredExpenses(
    makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1'], 'delivery-first', 'same-order'),
    harness.database,
    harness.journalCreator,
  );
  await recordShipmentDeliveredExpenses(
    makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1'], 'delivery-replay', 'same-order'),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(expenseTotal(harness.expenses), 300);
  assert.equal(harness.journalCreateCount, 1);
});

test('PER_ORDER charges the configured amount for each of five distinct orders', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  for (let index = 1; index <= 5; index += 1) {
    await recordShipmentDeliveredExpenses(
      makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1'], `per-order-delivery-${index}`, `per-order-${index}`),
      harness.database,
      harness.journalCreator,
    );
  }

  assert.equal(harness.expenseCreateCount, 5);
  assert.equal(expenseTotal(harness.expenses), 1500);
  assert.equal(harness.journalCreateCount, 5);
  assert.equal(harness.journalAmounts.reduce((sum, lines) => sum + lines[0], 0), 1500);
});

test('PER_ORDER charges the configured amount for each of twenty distinct orders', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  for (let index = 1; index <= 20; index += 1) {
    await recordShipmentDeliveredExpenses(
      makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1'], `per-order-delivery-${index}`, `per-order-${index}`),
      harness.database,
      harness.journalCreator,
    );
  }

  assert.equal(harness.expenseCreateCount, 20);
  assert.equal(expenseTotal(harness.expenses), 6000);
  assert.equal(harness.journalCreateCount, 20);
});

test('PER_DAY charges once for multiple same-shop deliveries on the same UTC business day', async () => {
  const harness = createDatabase([fee('fee-per-day', PER_DAY_PROVIDER_ID, '300.00', null, 'PER_DAY')]);

  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    recordShipmentDeliveredExpenses(
      makeEvent(PER_DAY_PROVIDER_ID, ['shop-1'], `per-day-delivery-${index}`, `per-day-order-${index}`),
      harness.database,
      harness.journalCreator,
    )));

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(expenseTotal(harness.expenses), 300);
  assert.equal(harness.journalCreateCount, 1);
});

test('PER_DAY creates a new charge for the same provider and shop on another UTC day', async () => {
  const harness = createDatabase([fee('fee-per-day', PER_DAY_PROVIDER_ID, '300.00', null, 'PER_DAY')]);

  await recordShipmentDeliveredExpenses(
    makeEvent(PER_DAY_PROVIDER_ID, ['shop-1'], 'first-day-delivery', 'first-day-order', '2026-10-07T23:59:00.000Z'),
    harness.database,
    harness.journalCreator,
  );
  await recordShipmentDeliveredExpenses(
    makeEvent(PER_DAY_PROVIDER_ID, ['shop-1'], 'second-day-delivery', 'second-day-order', '2026-10-08T00:01:00.000Z'),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(harness.expenseCreateCount, 2);
  assert.equal(expenseTotal(harness.expenses), 600);
  assert.equal(harness.journalCreateCount, 2);
});

test('customer-paid shipping fee does not affect the configured shop-paid fee', async () => {
  const harness = createDatabase([fee('fee-per-order', PER_ORDER_PROVIDER_ID, '300.00')]);

  await recordShipmentDeliveredExpenses(
    makeEvent(PER_ORDER_PROVIDER_ID, ['shop-1'], 'customer-fee-delivery', 'customer-fee-order', undefined, 9000),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(expenseTotal(harness.expenses), 300);
  assert.equal(harness.journalAmounts[0][0], 300);
});

test('charge references are based on providerId, shop, and order or business day', () => {
  const input = buildShipmentDeliveredExpense(makeEvent());
  const dayInput = { ...input, providerId: PER_DAY_PROVIDER_ID };
  const sameProviderDifferentCourierCode = makeEvent();
  sameProviderDifferentCourierCode.data.delivery.courier.code = 'UNRELATED-CODE';

  assert.match(buildDeliveryExpenseReference('PER_ORDER', input), /^DELI-ORDER-/);
  assert.equal(
    buildDeliveryExpenseReference('PER_ORDER', input),
    buildDeliveryExpenseReference(
      'PER_ORDER',
      buildShipmentDeliveredExpense(sameProviderDifferentCourierCode),
    ),
  );
  assert.match(buildDeliveryExpenseReference('PER_DAY', dayInput), /^DELI-DAY-/);
});
