import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildDeliveryInvoiceExpenseReference,
  buildDeliveryExpenseReference,
  buildShipmentDeliveredExpense,
  normalizeShipmentDeliveredEvent,
  PermanentShipmentDeliveredEventError,
  recordCodCollectionBatchExpense,
  recordShipmentDeliveredExpenses,
  selectApplicableDeliveryFee,
} from './shipment-delivered.consumer.js';
import type { ShipmentDeliveredEvent } from './shipment-delivered.consumer.js';
import { createJournalEntryInTransaction } from '../../modules/entries/entry.service.js';

const DELIVERY_COMPANY_ID = 'company-royal';
const SHOP_ID = 'shop-1';
const makeEvent = (
  shopIds: Array<string | null> = [SHOP_ID],
  deliveryId = 'delivery-1',
  orderId = 'order-1',
  deliveredAt = '2026-10-07T01:00:00.000Z',
  customerShippingFee?: number,
  deliveryCompanyId = DELIVERY_COMPANY_ID,
) => normalizeShipmentDeliveredEvent({
  event_id: `delivered-event-${deliveryId}`,
  event: 'shipment.delivered',
  version: 'v1',
  timestamp: '2026-10-07T01:00:00.000Z',
  delivery_id: deliveryId,
  data: {
    order_id: orderId,
    deliveryCompanyId,
    shopId: shopIds.length === 1 ? shopIds[0] : undefined,
    ...(customerShippingFee === undefined ? {} : { shipping_fee: customerShippingFee }),
    delivery: {
      deliveryId,
      deliveryNumber: `DLV-${deliveryId}`,
      deliveryCompanyId,
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
  shopId: string;
  deliveryCompanyId: string;
  chargingBasis: 'PER_ORDER' | 'PER_INVOICE';
  amount: Prisma.Decimal;
  currency: string;
  active: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdAt: Date;
};

function createDatabase(fees: Fee[]) {
  const expenses = new Map<string, Record<string, unknown>>();
  const expenseOrderLinks = new Set<string>();
  const journalReferences = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const feeLookupScopes: Array<{ shopId: string; deliveryCompanyId: string }> = [];
  let expenseCreateCount = 0;
  const journalAmounts: number[][] = [];
  const journalAccountCodes: string[][] = [];
  const tx = {
    deliveryCompanyFee: {
      findMany: async ({ where }: { where: { shopId: string; deliveryCompanyId: string } }) => {
        feeLookupScopes.push({
          shopId: where.shopId,
          deliveryCompanyId: where.deliveryCompanyId,
        });
        return fees.filter((candidate) =>
          candidate.shopId === where.shopId
          && candidate.deliveryCompanyId === where.deliveryCompanyId
        );
      },
    },
    expense: {
      findUnique: async ({ where }: { where: { expenseNo: string } }) =>
        expenses.get(where.expenseNo) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.expenseNo && typeof where.expenseNo === 'object' && 'in' in where.expenseNo) {
          const references = (where.expenseNo as { in: string[] }).in;
          return references.map((expenseNo) => expenses.get(expenseNo)).find(Boolean) ?? null;
        }
        return [...expenses.values()].find((expense) =>
          Object.entries(where).every(([key, value]) => expense[key] === value)
        ) ?? null;
      },
      findMany: async ({ where }: { where: { expenseNo: { startsWith: string } } }) =>
        [...expenses.values()]
          .filter((expense) => typeof expense.expenseNo === 'string'
            && expense.expenseNo.startsWith(where.expenseNo.startsWith))
          .map((expense) => ({ expenseNo: expense.expenseNo })),
      upsert: async (args: {
        where: { expenseNo: string };
        create: Record<string, unknown>;
      }) => {
        const existing = expenses.get(args.where.expenseNo);
        if (existing) return existing;
        expenseCreateCount += 1;
        const created = { ...args.create, id: `expense-${expenseCreateCount}` };
        expenses.set(args.where.expenseNo, created);
        return created;
      },
    },
    expenseCategory: {
      upsert: async () => ({ id: 'delivery-category' }),
    },
    journalEntry: {
      findFirst: async (args: { where: { referenceType: string; referenceId: string } }) =>
        journalReferences.has(args.where.referenceId) ? { id: 'journal-1' } : null,
    },
    deliveryExpenseOrder: {
      findMany: async ({ where }: { where: { expenseId: string } }) =>
        [...expenseOrderLinks]
          .filter((link) => link.startsWith(`${where.expenseId}:`))
          .map((link) => ({ orderId: link.slice(where.expenseId.length + 1) })),
      createMany: async ({ data }: { data: Array<{ expenseId: string; orderId: string }> }) => {
        data.forEach((row) => expenseOrderLinks.add(`${row.expenseId}:${row.orderId}`));
        return { count: data.length };
      },
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
          const lock = new Promise<void>((resolve) => { release = resolve; });
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
    journalAccountCodes.push(input.lines.map((line) => line.accountCode));
    return undefined as never;
  };

  return {
    database,
    journalCreator,
    expenses,
    expenseOrderLinks,
    feeLookupScopes,
    get expenseCreateCount() { return expenseCreateCount; },
    get journalCreateCount() { return journalAmounts.length; },
    get journalAmounts() { return journalAmounts; },
    get journalAccountCodes() { return journalAccountCodes; },
  };
}

const fee = (
  id: string,
  amount: string,
  chargingBasis: Fee['chargingBasis'] = 'PER_ORDER',
  effectiveFrom: string | null = null,
  effectiveTo: string | null = null,
  shopId = SHOP_ID,
  deliveryCompanyId = DELIVERY_COMPANY_ID,
): Fee => ({
  id,
  shopId,
  deliveryCompanyId,
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

test('builds a delivery expense from the canonical company and shop identities', () => {
  const expense = buildShipmentDeliveredExpense(makeEvent());

  assert.equal(expense.orderId, 'order-1');
  assert.equal(expense.deliveryId, 'delivery-1');
  assert.equal(expense.shopId, SHOP_ID);
  assert.equal(expense.deliveryCompanyId, DELIVERY_COMPANY_ID);
  assert.equal(expense.expenseDate.toISOString(), '2026-10-07T01:00:00.000Z');
});

test('finds the fee by both shop and Delivery Company identity', async () => {
  const harness = createDatabase([
    fee('shop-b-rule', '900.00', 'PER_ORDER', null, null, 'shop-2'),
    fee('same-company-rule', '300.00'),
  ]);

  await recordShipmentDeliveredExpenses(makeEvent(), harness.database, harness.journalCreator);

  assert.deepEqual(harness.feeLookupScopes, [{
    shopId: SHOP_ID,
    deliveryCompanyId: DELIVERY_COMPANY_ID,
  }]);
  const expense = [...harness.expenses.values()][0];
  assert.equal(expense?.amount?.toString(), '300');
  assert.equal(expense?.deliveryCompanyId, DELIVERY_COMPANY_ID);
  assert.equal(expense?.shopId, SHOP_ID);
});

test('delivery-expense journal posting is separate from COD collection accounting', async () => {
  const harness = createDatabase([fee('shop-delivery-fee', '300.00')]);
  const buyerConfirmedDelivery = makeEvent();

  await recordShipmentDeliveredExpenses(
    buyerConfirmedDelivery,
    harness.database,
    harness.journalCreator,
  );

  assert.deepEqual(harness.journalAccountCodes, [['5000', '1000']]);
  assert.equal(harness.journalAccountCodes.flat().includes('1200'), false);
  assert.equal(harness.journalAccountCodes.flat().includes('1210'), false);
});

test('does not use another shop or Delivery Company fee', async () => {
  const harness = createDatabase([
    fee('wrong-shop', '900.00', 'PER_ORDER', null, null, 'shop-2'),
    fee('wrong-company', '800.00', 'PER_ORDER', null, null, SHOP_ID, 'another-company'),
  ]);

  await assert.rejects(
    recordShipmentDeliveredExpenses(makeEvent(), harness.database, harness.journalCreator),
    /No active delivery fee applies/,
  );
  assert.equal(harness.expenseCreateCount, 0);
});

test('selects the latest fee effective at delivery time', () => {
  const selected = selectApplicableDeliveryFee([
    fee('current', '320.00', 'PER_ORDER', '2026-10-01T00:00:00.000Z'),
    fee('future', '350.00', 'PER_ORDER', '2026-11-01T00:00:00.000Z'),
    fee('default', '300.00'),
  ], new Date('2026-10-07T01:00:00.000Z'));

  assert.equal(selected?.id, 'current');
});

test('rejects missing and conflicting Delivery Company identities', () => {
  const missingCompany = makeEvent();
  assert.throws(() => normalizeShipmentDeliveredEvent({
    ...missingCompany,
    data: { ...missingCompany.data, deliveryCompanyId: undefined },
  }));

  const conflictingCompany = makeEvent();
  conflictingCompany.data.delivery.deliveryCompanyId = 'another-company';
  assert.throws(
    () => buildShipmentDeliveredExpense(conflictingCompany),
    (error: unknown) => error instanceof PermanentShipmentDeliveredEventError
      && /conflicting Delivery Company IDs/.test(error.message),
  );
});

test('rejects invalid delivered times and missing shop attribution', () => {
  const invalidDate = makeEvent();
  invalidDate.data.delivery.timeline.deliveredAt = 'not-a-date';
  assert.throws(() => buildShipmentDeliveredExpense(invalidDate), /invalid .*deliveredAt/);

  const missingShop = makeEvent([null]);
  missingShop.data.shopId = undefined;
  missingShop.data.delivery.shopId = undefined;
  assert.throws(
    () => buildShipmentDeliveredExpense(missingShop),
    /no complete item shop attribution/,
  );
});

test('duplicate delivered events create one expense and one journal entry', async () => {
  const harness = createDatabase([fee('per-order-fee', '300.00')]);
  const event: ShipmentDeliveredEvent = makeEvent();

  await Promise.all([
    recordShipmentDeliveredExpenses(event, harness.database, harness.journalCreator),
    recordShipmentDeliveredExpenses(event, harness.database, harness.journalCreator),
  ]);

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(harness.journalCreateCount, 1);
  assert.deepEqual(harness.journalAmounts, [[300, 300]]);
});

test('PER_ORDER charges once per shop, company, and order', async () => {
  const harness = createDatabase([fee('per-order-fee', '300.00')]);
  await recordShipmentDeliveredExpenses(
    makeEvent([SHOP_ID], 'delivery-a', 'same-order'),
    harness.database,
    harness.journalCreator,
  );
  await recordShipmentDeliveredExpenses(
    makeEvent([SHOP_ID], 'delivery-b', 'same-order'),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(expenseTotal(harness.expenses), 300);
});

test('shipment delivery events do not invent a PER_INVOICE batch', async () => {
  const harness = createDatabase([fee('per-invoice-fee', '300.00', 'PER_INVOICE')]);
  await Promise.all(Array.from({ length: 4 }, (_, index) =>
    recordShipmentDeliveredExpenses(
      makeEvent([SHOP_ID], `delivery-${index}`, `order-${index}`),
      harness.database,
      harness.journalCreator,
    )));
  await recordShipmentDeliveredExpenses(
    makeEvent([SHOP_ID], 'next-day-delivery', 'next-day-order', '2026-10-08T00:01:00.000Z'),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(harness.expenseCreateCount, 0);
  assert.equal(expenseTotal(harness.expenses), 0);
});

test('PER_INVOICE charges the configured fee once and links every order in the COD batch', async () => {
  const harness = createDatabase([fee('per-invoice-fee', '400.00', 'PER_INVOICE')]);
  await recordCodCollectionBatchExpense({
    groupId: 'cod-batch-a',
    shopId: SHOP_ID,
    deliveryCompanyId: DELIVERY_COMPANY_ID,
    orderIds: ['ORD-001', 'ORD-002', 'ORD-003', 'ORD-004', 'ORD-005'],
    effectiveAt: new Date('2026-10-09T11:00:00.000Z'),
  }, 'payment-collected-a', harness.database, harness.journalCreator);

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(expenseTotal(harness.expenses), 400);
  assert.equal(harness.expenseOrderLinks.size, 5);
  assert.deepEqual(
    [...harness.expenseOrderLinks].map((link) => link.split(':')[1]).sort(),
    ['ORD-001', 'ORD-002', 'ORD-003', 'ORD-004', 'ORD-005'],
  );
  assert.deepEqual([...harness.expenses.values()].map((expense) => expense.currency), ['MMK']);
  assert.deepEqual([...harness.expenses.values()].map((expense) => expense.expenseNo), [
    'DELI-INVOICE-20261009-0001',
  ]);
  assert.equal(harness.journalCreateCount, 1);
});

test('distinct PER_INVOICE batches on the same day create separate expenses', async () => {
  const harness = createDatabase([fee('per-invoice-fee', '400.00', 'PER_INVOICE')]);
  const effectiveAt = new Date('2026-10-09T11:00:00.000Z');
  for (const [groupId, orderIds] of [
    ['cod-batch-a', ['ORD-001', 'ORD-002', 'ORD-003', 'ORD-004', 'ORD-005']],
    ['cod-batch-b', ['ORD-006', 'ORD-007']],
  ] as const) {
    await recordCodCollectionBatchExpense({
      groupId,
      shopId: SHOP_ID,
      deliveryCompanyId: DELIVERY_COMPANY_ID,
      orderIds: [...orderIds],
      effectiveAt,
    }, `${groupId}-event`, harness.database, harness.journalCreator);
  }

  assert.equal(harness.expenseCreateCount, 2);
  assert.equal(expenseTotal(harness.expenses), 800);
  assert.equal(harness.expenseOrderLinks.size, 7);
  assert.deepEqual(
    [...harness.expenses.values()].map((expense) => expense.expenseNo).sort(),
    ['DELI-INVOICE-20261009-0001', 'DELI-INVOICE-20261009-0002'],
  );
});

test('duplicate and concurrent PER_INVOICE events create one expense and journal', async () => {
  const harness = createDatabase([fee('per-invoice-fee', '400.00', 'PER_INVOICE')]);
  const input = {
    groupId: 'cod-batch-repeat',
    shopId: SHOP_ID,
    deliveryCompanyId: DELIVERY_COMPANY_ID,
    orderIds: ['ORD-001', 'ORD-002', 'ORD-003', 'ORD-004', 'ORD-005'],
    effectiveAt: new Date('2026-10-09T11:00:00.000Z'),
  };
  await Promise.all(Array.from({ length: 4 }, () =>
    recordCodCollectionBatchExpense(input, 'same-batch-event', harness.database, harness.journalCreator)));

  assert.equal(harness.expenseCreateCount, 1);
  assert.equal(expenseTotal(harness.expenses), 400);
  assert.equal(harness.expenseOrderLinks.size, 5);
  assert.equal(harness.journalCreateCount, 1);
  assert.equal(
    [...harness.expenses.values()][0].expenseNo,
    'DELI-INVOICE-20261009-0001',
  );
});

test('a replayed batch ID cannot add unrelated orders to an existing expense', async () => {
  const harness = createDatabase([fee('per-invoice-fee', '400.00', 'PER_INVOICE')]);
  const baseInput = {
    groupId: 'cod-batch-fixed-membership',
    shopId: SHOP_ID,
    deliveryCompanyId: DELIVERY_COMPANY_ID,
    orderIds: ['ORD-001', 'ORD-002'],
    effectiveAt: new Date('2026-10-09T11:00:00.000Z'),
  };
  await recordCodCollectionBatchExpense(baseInput, 'initial-event', harness.database, harness.journalCreator);

  await assert.rejects(
    recordCodCollectionBatchExpense({ ...baseInput, orderIds: ['ORD-001', 'ORD-003'] }, 'mismatched-event', harness.database, harness.journalCreator),
    /different order membership/,
  );
  assert.equal(harness.expenseCreateCount, 1);
  assert.deepEqual([...harness.expenseOrderLinks].map((link) => link.split(':')[1]).sort(), ['ORD-001', 'ORD-002']);
  assert.equal(harness.journalCreateCount, 1);
});

test('PER_INVOICE expense identity isolates shops and delivery providers', async () => {
  const harness = createDatabase([
    fee('shop-1-provider-1', '400.00', 'PER_INVOICE', null, null, SHOP_ID, DELIVERY_COMPANY_ID),
    fee('shop-2-provider-1', '500.00', 'PER_INVOICE', null, null, 'shop-2', DELIVERY_COMPANY_ID),
    fee('shop-1-provider-2', '600.00', 'PER_INVOICE', null, null, SHOP_ID, 'company-other'),
  ]);
  const effectiveAt = new Date('2026-10-09T11:00:00.000Z');
  for (const [shopId, deliveryCompanyId, orderId] of [
    [SHOP_ID, DELIVERY_COMPANY_ID, 'ORD-001'],
    ['shop-2', DELIVERY_COMPANY_ID, 'ORD-002'],
    [SHOP_ID, 'company-other', 'ORD-003'],
  ]) {
    await recordCodCollectionBatchExpense({
      groupId: 'stable-group-token',
      shopId,
      deliveryCompanyId,
      orderIds: [orderId],
      effectiveAt,
    }, `${orderId}-event`, harness.database, harness.journalCreator);
  }

  assert.equal(harness.expenseCreateCount, 3);
  assert.equal(expenseTotal(harness.expenses), 1500);
});

test('PER_ORDER remains shipment-triggered and is not repriced by COD batch time', async () => {
  const harness = createDatabase([fee('per-order-fee', '80.00', 'PER_ORDER')]);
  await recordCodCollectionBatchExpense({
    groupId: 'cod-batch-per-order',
    shopId: SHOP_ID,
    deliveryCompanyId: DELIVERY_COMPANY_ID,
    orderIds: ['ORD-001', 'ORD-002', 'ORD-003', 'ORD-004', 'ORD-005'],
    effectiveAt: new Date('2026-10-09T11:00:00.000Z'),
  }, 'per-order-event', harness.database, harness.journalCreator);

  assert.equal(harness.expenseCreateCount, 0);
  assert.equal(expenseTotal(harness.expenses), 0);
  assert.equal(harness.expenseOrderLinks.size, 0);
});

test('customer shipping charge remains separate from Delivery Company expense', async () => {
  const harness = createDatabase([fee('company-fee', '300.00')]);
  await recordShipmentDeliveredExpenses(
    makeEvent([SHOP_ID], 'customer-charge', 'order-customer-charge', undefined, 9000),
    harness.database,
    harness.journalCreator,
  );

  assert.equal(expenseTotal(harness.expenses), 300);
  assert.equal(harness.journalAmounts[0][0], 300);
});

test('expense references include the shop and Delivery Company identity', () => {
  const input = buildShipmentDeliveredExpense(makeEvent());
  const companySpecificInput = { ...input, deliveryCompanyId: 'another-company' };

  assert.match(buildDeliveryExpenseReference('PER_ORDER', input), /^DELI-ORDER-/);
  assert.match(
    buildDeliveryExpenseReference('PER_INVOICE', { ...input, deliveryExpenseGroupId: 'batch-1' }),
    /^DELI-INVOICE-/,
  );
  assert.equal(
    buildDeliveryInvoiceExpenseReference(new Date(2026, 9, 9), 1),
    'DELI-INVOICE-20261009-0001',
  );
  assert.notEqual(
    buildDeliveryExpenseReference('PER_ORDER', input),
    buildDeliveryExpenseReference('PER_ORDER', companySpecificInput),
  );
});
