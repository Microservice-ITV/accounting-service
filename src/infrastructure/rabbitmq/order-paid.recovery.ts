import prisma from '../../lib/prisma.js';
import {
  buildOrderPaidPaymentJournalEventId,
  buildPnlOrderShopProjections,
  normalizeOrderPaidEvent,
  upsertPnlOrderShopProjection,
} from './payment.consumer.js';

type OrderPaidEvent = ReturnType<typeof normalizeOrderPaidEvent>;
type Projection = ReturnType<typeof buildPnlOrderShopProjections>[number];

export type RecoveryProjectionRecord = {
  orderId: string;
  shopId: string;
  sourceEventId: string;
  shopOrderId: string | null;
  currency: string;
  grossItemSales: number;
  discountTotal: number;
  shippingTotal: number;
  paidAmount: number;
  orderPaidAt: Date;
  discounts: Array<{
    promotionId: string | null;
    rewardId: string | null;
    discountType: string;
    fundedBy: string;
    amount: number;
  }>;
};

export type RecoveryJournalRecord = {
  referenceType: string;
  referenceId: string;
  eventId: string | null;
};

export type OrderPaidRecoveryTransaction = {
  findProjections(orderId: string): Promise<RecoveryProjectionRecord[]>;
  findSettlement(paymentId: string): Promise<{ paymentReference: string } | null>;
  findRelatedJournals(
    paymentId: string,
    orderId: string,
    eventIds: string[],
  ): Promise<RecoveryJournalRecord[]>;
  upsertProjection(projection: Projection): Promise<void>;
};

export type OrderPaidRecoveryDependencies = {
  withTransaction<T>(work: (transaction: OrderPaidRecoveryTransaction) => Promise<T>): Promise<T>;
};

const prismaRecoveryDependencies: OrderPaidRecoveryDependencies = {
  withTransaction: (work) => prisma.$transaction(async (tx) => work({
    findProjections: async (orderId) => {
      const rows = await tx.pnlOrderShop.findMany({
        where: { orderId },
        include: { discounts: true },
      });
      return rows.map((row) => ({
        orderId: row.orderId,
        shopId: row.shopId,
        sourceEventId: row.sourceEventId,
        shopOrderId: row.shopOrderId,
        currency: row.currency,
        grossItemSales: Number(row.grossItemSales.toString()),
        discountTotal: Number(row.discountTotal.toString()),
        shippingTotal: Number(row.shippingTotal.toString()),
        paidAmount: Number(row.paidAmount.toString()),
        orderPaidAt: row.orderPaidAt,
        discounts: row.discounts.map((discount) => ({
          promotionId: discount.promotionId,
          rewardId: discount.rewardId,
          discountType: discount.discountType,
          fundedBy: discount.fundedBy,
          amount: Number(discount.amount.toString()),
        })),
      }));
    },
    findSettlement: (paymentId) => tx.paymentSettlement.findUnique({
      where: { paymentReference: paymentId },
      select: { paymentReference: true },
    }),
    findRelatedJournals: async (paymentId, orderId, eventIds) => {
      const expenses = await tx.expense.findMany({
        where: { deliveryOrders: { some: { orderId } } },
        select: { expenseNo: true },
      });
      return tx.journalEntry.findMany({
        where: {
          OR: [
            { referenceType: 'PAYMENT', referenceId: paymentId },
            { eventId: { in: eventIds } },
            {
              referenceType: 'EXPENSE',
              referenceId: { in: expenses.map((expense) => expense.expenseNo) },
            },
          ],
        },
        select: { referenceType: true, referenceId: true, eventId: true },
      });
    },
    upsertProjection: async (projection) => {
      await upsertPnlOrderShopProjection(tx, projection);
    },
  }), { isolationLevel: 'Serializable' }),
};

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function assertExistingProjectionMatches(
  existing: RecoveryProjectionRecord,
  expected: Projection,
): void {
  if (
    existing.sourceEventId !== expected.sourceEventId
    || existing.shopOrderId !== expected.shopOrderId
    || existing.currency !== expected.currency
    || toCents(existing.grossItemSales) !== toCents(expected.grossItemSales)
    || toCents(existing.discountTotal) !== toCents(expected.discountTotal)
    || toCents(existing.shippingTotal) !== toCents(expected.shippingTotal)
    || toCents(existing.paidAmount) !== toCents(expected.paidAmount)
    || existing.orderPaidAt.getTime() !== expected.orderPaidAt.getTime()
  ) {
    throw new Error(`Existing projection conflicts with order.paid event for shop ${expected.shopId}`);
  }
}

export async function recoverOrderPaidProjection(
  rawEvent: unknown,
  expected: { eventId: string; orderId: string; paymentId: string },
  dependencies: OrderPaidRecoveryDependencies = prismaRecoveryDependencies,
): Promise<{ projectionCount: number }> {
  const event = normalizeOrderPaidEvent(rawEvent);
  if (
    event.event_id !== expected.eventId
    || event.data.order_id !== expected.orderId
    || event.data.payment_id !== expected.paymentId
  ) {
    throw new Error('Stored event does not match the explicitly confirmed event, order, and payment IDs');
  }

  const projections = buildPnlOrderShopProjections(event);
  if (new Set(projections.map((projection) => projection.shopId)).size !== projections.length) {
    throw new Error('Stored event contains duplicate shop allocations');
  }

  return dependencies.withTransaction(async (transaction) => {
    const existing = await transaction.findProjections(event.data.order_id);
    if (existing.length !== 0 && existing.length !== projections.length) {
      throw new Error('Existing order projection is incomplete; refusing partial recovery');
    }
    for (const projection of projections) {
      const row = existing.find((candidate) => candidate.shopId === projection.shopId);
      if (existing.length > 0 && !row) {
        throw new Error(`Existing projection is missing shop ${projection.shopId}`);
      }
      if (row) assertExistingProjectionMatches(row, projection);
    }

    const settlement = await transaction.findSettlement(event.data.payment_id!);
    if (settlement) {
      throw new Error('Payment settlement already exists; refusing projection-only recovery');
    }

    const incomeEventId = buildOrderPaidPaymentJournalEventId(event.data.payment_id!, event.event_id);
    const journals = await transaction.findRelatedJournals(
      event.data.payment_id!,
      event.data.order_id,
      [event.event_id, incomeEventId],
    );
    if (journals.some((journal) => journal.referenceType === 'PAYMENT')) {
      throw new Error('Payment journal already exists; refusing projection-only recovery');
    }
    if (journals.some((journal) => journal.eventId === event.event_id || journal.eventId === incomeEventId)) {
      throw new Error('A journal already owns an order.paid recovery event ID');
    }

    for (const projection of projections) {
      await transaction.upsertProjection(projection);
    }
    return { projectionCount: projections.length };
  });
}

export type RecoveryEnvironmentOptions = {
  requestedEnvironment: string;
  configuredEnvironment?: string;
  nodeEnvironment?: string;
  expectedHost: string;
  actualHost: string;
  expectedDatabase: string;
  actualDatabase?: string;
  allowProductionFlag: boolean;
  allowProductionEnvironmentVariable?: string;
};

export function assertRecoveryEnvironment(options: RecoveryEnvironmentOptions): void {
  const allowedEnvironments = new Set(['development', 'test', 'staging', 'production']);
  if (!allowedEnvironments.has(options.requestedEnvironment)) {
    throw new Error('Recovery requires an explicit supported target environment');
  }
  if (options.configuredEnvironment !== options.requestedEnvironment) {
    throw new Error('Target environment does not match ACCOUNTING_RECOVERY_ENVIRONMENT');
  }
  if (!options.expectedHost || options.actualHost !== options.expectedHost) {
    throw new Error('Connected database host does not match the explicitly expected host');
  }
  if (!options.expectedDatabase) {
    throw new Error('An expected database name is required');
  }
  if (options.actualDatabase !== undefined && options.actualDatabase !== options.expectedDatabase) {
    throw new Error('Connected database does not match the explicitly expected database');
  }
  if (options.requestedEnvironment === 'production') {
    if (
      options.nodeEnvironment !== 'production'
      || !options.allowProductionFlag
      || options.allowProductionEnvironmentVariable !== 'true'
    ) {
      throw new Error('Production recovery requires production mode and two explicit approvals');
    }
  } else if (options.nodeEnvironment === 'production') {
    throw new Error('Refusing non-production recovery from a production-mode process');
  }
}
