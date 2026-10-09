import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { createJournalEntryInTransaction } from '../../modules/entries/entry.service.js';
import { config } from '../../config/index.js';
import {
  PermanentShipmentDeliveredEventError,
  recordCodCollectionBatchExpense,
} from './shipment-delivered.consumer.js';

const shopBreakdownLineSchema = z.object({
  shop_id: z.string().min(1).optional(),
  seller_id: z.string().min(1).optional(),
  gross_amount: z.number().finite().nonnegative().optional(),
  net_payout: z.number().finite().nonnegative().optional(),
}).passthrough();

const paymentCompletedSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('payment.completed'),
  data: z.object({
    payment_id: z.string().min(1),
    order_id: z.string().min(1).optional(),
    checkout_id: z.string().min(1).optional(),
    amount: z.number().finite().positive(),
    currency: z.string().min(1).optional(),
    payment_method: z.string().min(1).optional(),
    status: z.enum(['SUCCESS', 'COMPLETED', 'succeeded', 'completed']).optional(),
    shop_id: z.string().min(1).optional(),
    seller_id: z.string().min(1).optional(),
    shop_breakdown: z.array(shopBreakdownLineSchema).optional(),
  }).passthrough(),
});

const paymentCollectedSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('payment.collected'),
  data: z.object({
    payment_id: z.string().min(1),
    order_id: z.string().min(1).optional(),
    checkout_id: z.string().min(1).optional(),
    amount: z.number().finite().positive(),
    currency: z.string().min(1).optional(),
    payment_method: z.string().min(1).optional(),
    shop_breakdown: z.array(z.object({
      shop_id: z.string().min(1),
      gross_amount: z.number().finite().nonnegative(),
    }).passthrough()).min(1),
    delivery_expense_group: z.object({
      group_id: z.string().min(1),
      shop_id: z.string().min(1),
      delivery_company_id: z.string().min(1),
      order_ids: z.array(z.string().min(1)).min(1),
      effective_at: z.string().datetime({ offset: true }),
    }).optional(),
  }).passthrough(),
});

const orderPaidSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('order.paid'),
  timestamp: z.string().optional(),
  data: z.object({
    order_id: z.string().min(1),
    payment_id: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    promotion_allocations: z.array(z.object({
      promotion_id: z.string().optional(),
      reward_id: z.string().optional(),
      shop_id: z.string().min(1),
      discount_type: z.enum(['ITEM', 'SHIPPING']),
      funded_by: z.enum(['SELLER', 'PLATFORM']),
      amount: z.number().finite().nonnegative(),
    }).passthrough()).optional(),
    shop_breakdown: z.array(z.object({
      shop_id: z.string().min(1),
      shop_order_id: z.string().min(1).optional(),
      subtotal: z.number().finite().nonnegative(),
      discount_total: z.number().finite().nonnegative().optional(),
      shipping_total: z.number().finite().nonnegative().optional(),
      grand_total: z.number().finite().nonnegative(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

type PaymentCompletedEvent = z.infer<typeof paymentCompletedSchema>;
type PaymentCollectedEvent = z.infer<typeof paymentCollectedSchema>;
type OrderPaidEvent = z.infer<typeof orderPaidSchema>;
type PaymentEvent = PaymentCompletedEvent | PaymentCollectedEvent | OrderPaidEvent;

export type PaymentJournalContext = {
  payment_id: string;
  order_id?: string;
  checkout_id?: string;
  amount: number;
  currency?: string;
  shop_id?: string;
  seller_id?: string;
  shop_breakdown?: Array<{
    shop_id?: string;
    seller_id?: string;
    gross_amount?: number;
    shipping_total?: number;
    net_payout?: number;
  }>;
};

export function normalizePaymentCompletedEvent(raw: unknown): PaymentCompletedEvent {
  const payload = paymentCompletedSchema.parse(raw);
  return payload;
}

export function normalizePaymentCollectedEvent(raw: unknown): PaymentCollectedEvent {
  return paymentCollectedSchema.parse(raw);
}

export function normalizeOrderPaidEvent(raw: unknown): OrderPaidEvent {
  return orderPaidSchema.parse(raw);
}

export function normalizePaymentEvent(raw: unknown): PaymentEvent {
  const event = z.object({ event: z.string() }).passthrough().parse(raw);
  if (event.event === 'payment.collected') return normalizePaymentCollectedEvent(raw);
  if (event.event === 'order.paid') return normalizeOrderPaidEvent(raw);
  return normalizePaymentCompletedEvent(raw);
}

export function shouldRecognizeCompletedPayment(event: PaymentCompletedEvent): boolean {
  return event.data.payment_method?.toLowerCase() !== 'cod';
}

export function shouldRecognizePaymentEvent(event: PaymentEvent): boolean {
  if (event.event === 'payment.collected') return true;
  if (event.event === 'payment.completed') return shouldRecognizeCompletedPayment(event);
  return false;
}

export function buildPnlOrderShopProjections(event: OrderPaidEvent, now = new Date()) {
  const allocationsByShop = new Map<string, OrderPaidEvent['data']['promotion_allocations']>();
  for (const allocation of event.data.promotion_allocations ?? []) {
    const allocations = allocationsByShop.get(allocation.shop_id) ?? [];
    allocations.push(allocation);
    allocationsByShop.set(allocation.shop_id, allocations);
  }

  const orderPaidAtValue = event.timestamp;
  const parsedOrderPaidAt = orderPaidAtValue ? new Date(orderPaidAtValue) : now;
  const orderPaidAt = Number.isNaN(parsedOrderPaidAt.getTime()) ? now : parsedOrderPaidAt;

  return event.data.shop_breakdown.map((shop) => {
    const discounts = allocationsByShop.get(shop.shop_id) ?? [];
    const allocatedCents = discounts.reduce((sum, allocation) =>
      sum + Math.round(Number(allocation.amount) * 100), 0);
    const discountCents = Math.round(Number(shop.discount_total ?? 0) * 100);

    return {
      orderId: event.data.order_id,
      shopOrderId: shop.shop_order_id ?? null,
      sourceEventId: event.event_id,
      shopId: shop.shop_id,
      currency: event.data.currency ?? 'MMK',
      grossItemSales: shop.subtotal,
      discountTotal: shop.discount_total ?? 0,
      shippingTotal: shop.shipping_total ?? 0,
      paidAmount: shop.grand_total,
      discountAllocationsComplete: allocatedCents === discountCents,
      orderPaidAt,
      discounts: discounts.map((discount) => ({
        promotionId: discount.promotion_id ?? null,
        rewardId: discount.reward_id ?? null,
        discountType: discount.discount_type,
        fundedBy: discount.funded_by,
        amount: discount.amount,
      })),
    };
  });
}

type SettlementAllocation = {
  shop_id?: string | null;
  seller_id?: string | null;
  gross_amount: number;
  shipping_total?: number;
  net_payout?: number;
};

async function savePaymentSettlement(
  input: {
    paymentId: string;
    orderId?: string;
    checkoutId?: string;
    eventId: string;
    currency?: string;
    amount: number;
  },
  allocations: SettlementAllocation[],
): Promise<void> {
  const totalPayable = allocations.reduce((sum, row) => sum + Number(row.net_payout ?? row.gross_amount), 0);

  await prisma.$transaction(async (tx) => {
    const settlement = await tx.paymentSettlement.upsert({
      where: { paymentReference: input.paymentId },
      update: {
        orderId: input.orderId ?? null,
        checkoutId: input.checkoutId ?? null,
        eventId: input.eventId,
        currency: input.currency ?? 'MMK',
        totalAmount: input.amount,
        sellerPayableAmount: totalPayable,
      },
      create: {
        paymentReference: input.paymentId,
        orderId: input.orderId ?? null,
        checkoutId: input.checkoutId ?? null,
        eventId: input.eventId,
        currency: input.currency ?? 'MMK',
        totalAmount: input.amount,
        sellerPayableAmount: totalPayable,
      },
    });

    await tx.paymentSettlementLine.deleteMany({ where: { settlementId: settlement.id } });
    if (allocations.length > 0) {
      await tx.paymentSettlementLine.createMany({
        data: allocations.map((row) => ({
          settlementId: settlement.id,
          shopId: row.shop_id ?? null,
          sellerId: row.seller_id ?? null,
          grossAmount: row.gross_amount,
          payableAmount: row.net_payout ?? row.gross_amount,
          currency: input.currency ?? 'MMK',
        })),
      });
    }
  });
}

async function getOrderShopSettlementAllocations(orderId: string): Promise<SettlementAllocation[]> {
  const projections = await prisma.pnlOrderShop.findMany({ where: { orderId } });
  return projections.map((row) => ({
    shop_id: row.shopId,
    gross_amount: Number(row.paidAmount.toString()),
    shipping_total: Number(row.shippingTotal.toString()),
    net_payout: Number(row.paidAmount.toString()),
  }));
}

async function getOrderShopRevenueAllocations(orderId: string): Promise<SettlementAllocation[]> {
  const projections = await prisma.pnlOrderShop.findMany({ where: { orderId } });
  return projections.map((row) => ({
    shop_id: row.shopId,
    gross_amount: Number(row.paidAmount.toString()),
    shipping_total: Number(row.shippingTotal.toString()),
  }));
}

function validateCollectedShopAllocations(
  event: PaymentCollectedEvent,
  projections: SettlementAllocation[],
) {
  const eventAllocations = new Map<string, number>();
  for (const allocation of event.data.shop_breakdown) {
    if (eventAllocations.has(allocation.shop_id)) {
      throw new Error('COD payment requires unique shop allocations');
    }
    eventAllocations.set(allocation.shop_id, Math.round(allocation.gross_amount * 100));
  }

  const eventTotalCents = [...eventAllocations.values()].reduce((sum, amount) => sum + amount, 0);
  if (eventTotalCents !== Math.round(event.data.amount * 100)) {
    throw new Error('COD payment allocation total does not match payment amount');
  }

  if (
    eventAllocations.size !== projections.length
    || projections.some((projection) =>
      !projection.shop_id
      || eventAllocations.get(projection.shop_id) !== Math.round(projection.gross_amount * 100),
    )
  ) {
    throw new Error('COD payment allocations do not match the order sales projection');
  }
}

async function syncOrderPaidSettlement(event: OrderPaidEvent): Promise<void> {
  const paymentId = event.data.payment_id;
  if (!paymentId) return;

  const settlement = await prisma.paymentSettlement.findUnique({
    where: { paymentReference: paymentId },
    select: { id: true },
  });
  if (!settlement) return;

  const allocations = event.data.shop_breakdown.map((shop) => ({
    shop_id: shop.shop_id,
    gross_amount: shop.grand_total,
    net_payout: shop.grand_total,
  }));
  await prisma.$transaction(async (tx) => {
    await tx.paymentSettlementLine.deleteMany({ where: { settlementId: settlement.id } });
    await tx.paymentSettlementLine.createMany({
      data: allocations.map((row) => ({
        settlementId: settlement.id,
        shopId: row.shop_id,
        grossAmount: row.gross_amount,
        payableAmount: row.net_payout,
        currency: event.data.currency ?? 'MMK',
      })),
    });
  });
}

export function buildPaymentJournalLines(context: PaymentJournalContext) {
  const detailParts = [
    context.order_id ? `order=${context.order_id}` : null,
    context.shop_id ? `shop=${context.shop_id}` : null,
    context.seller_id ? `seller=${context.seller_id}` : null,
    context.checkout_id ? `checkout=${context.checkout_id}` : null,
  ].filter(Boolean);

  const detailSuffix = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
  const currencyLabel = context.currency ? ` (${context.currency})` : '';

  return [
    {
      accountCode: '1000',
      direction: 'DEBIT' as const,
      amount: context.amount,
      memo: `Payment received${currencyLabel}${detailSuffix}`,
    },
    {
      accountCode: '4000',
      direction: 'CREDIT' as const,
      amount: context.amount,
      memo: `Revenue recognized${currencyLabel}${detailSuffix}`,
    },
  ];
}

export function buildMerchandisePaymentJournalLines(
  context: PaymentJournalContext,
  allocations: SettlementAllocation[],
  cashMemo: string,
) {
  const normalized = allocations.map((row) => {
    if (!row.shop_id || row.shipping_total === undefined) {
      throw new Error('Payment income requires shop sales and shipping allocations');
    }
    const grossCents = Math.round(Number(row.gross_amount) * 100);
    const shippingCents = Math.round(Number(row.shipping_total) * 100);
    if (
      !Number.isFinite(grossCents)
      || !Number.isFinite(shippingCents)
      || grossCents < 0
      || shippingCents < 0
      || shippingCents > grossCents
    ) {
      throw new Error('Payment income contains invalid shop sales or shipping allocations');
    }
    return {
      shopId: row.shop_id,
      grossCents,
      shippingCents,
      merchandiseCents: grossCents - shippingCents,
    };
  });

  if (normalized.length === 0) {
    throw new Error('Payment income requires shop allocations');
  }

  const allocatedCents = normalized.reduce((sum, row) => sum + row.grossCents, 0);
  if (allocatedCents !== Math.round(context.amount * 100)) {
    throw new Error('Payment allocation total does not match payment amount');
  }

  const currencyLabel = context.currency ? ` (${context.currency})` : '';
  const orderPart = context.order_id ? `order=${context.order_id}, ` : '';
  const incomeLines = normalized
    .filter((row) => row.merchandiseCents > 0)
    .map((row) => ({
      accountCode: '4000',
      direction: 'CREDIT' as const,
      amount: row.merchandiseCents / 100,
      memo: `Revenue recognized${currencyLabel} (${orderPart}shop=${row.shopId})`,
    }));
  const shippingLines = normalized
    .filter((row) => row.shippingCents > 0)
    .map((row) => ({
      accountCode: '2000',
      direction: 'CREDIT' as const,
      amount: row.shippingCents / 100,
      memo: `Delivery fee payable${currencyLabel} (${orderPart}shop=${row.shopId})`,
    }));

  if (incomeLines.length === 0 && shippingLines.length === 0) {
    throw new Error('Payment requires positive shop allocations');
  }

  return [
    {
      accountCode: '1000',
      direction: 'DEBIT' as const,
      amount: allocatedCents / 100,
      memo: `${cashMemo}${currencyLabel}${context.order_id ? ` (order=${context.order_id})` : ''}`,
    },
    ...incomeLines,
    ...shippingLines,
  ];
}

export function buildCollectedPaymentJournalLines(
  context: PaymentJournalContext,
  allocations: SettlementAllocation[],
) {
  return buildMerchandisePaymentJournalLines(context, allocations, 'COD cash collected');
}

export function calculateMarketplaceSettlement(context: PaymentJournalContext) {
  const normalizedRows = (context.shop_breakdown && context.shop_breakdown.length > 0
    ? context.shop_breakdown
    : [{
        shop_id: context.shop_id,
        seller_id: context.seller_id,
        gross_amount: context.amount,
        net_payout: context.amount,
      }])
    .map((row) => {
      const gross = Number(row.gross_amount ?? 0);
      const payable = Number(row.net_payout ?? gross);
      return {
        shop_id: row.shop_id,
        seller_id: row.seller_id,
        gross_amount: Number.isFinite(gross) ? gross : 0,
        payable_amount: Number.isFinite(payable) ? payable : 0,
      };
    });

  const totalGross = normalizedRows.reduce((sum, row) => sum + row.gross_amount, 0);
  const totalPayable = normalizedRows.reduce((sum, row) => sum + row.payable_amount, 0);

  const totalAmount = totalPayable;

  return {
    rows: normalizedRows,
    totalGross,
    totalPayable,
    totalAmount,
  };
}

export function buildSellerSettlementJournalLines(context: PaymentJournalContext) {
  const settlement = calculateMarketplaceSettlement(context);

  if (settlement.rows.length === 0) {
    return null;
  }

  const sellerPayable = settlement.totalPayable;
  if (Math.abs(sellerPayable - settlement.totalGross) > 0.0001) {
    throw new Error('Gross amount and net payout must match for this marketplace flow without extra fees');
  }

  // Settlement rows are tracking data only. The actual customer payment must be recorded once by the payment journal.
  // We do not create a second Cash debit here.
  return null;
}

let channel: Channel | null = null;
let connection: ChannelModel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

export const isPermanentError = (error: unknown): boolean => {
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof PermanentShipmentDeliveredEventError) {
    return true;
  }

  const message = error instanceof Error ? error.message : '';
  return message.startsWith('Journal entry is out of balance:')
    || message.startsWith('COD payment requires shop allocations')
    || message.startsWith('COD payment requires unique shop allocations')
    || message.startsWith('COD payment allocation total does not match payment amount')
    || message.startsWith('COD payment allocations do not match the order sales projection')
    || message.startsWith('Payment allocation total does not match payment amount')
    || message.startsWith('Payment income requires shop allocations')
    || message.startsWith('Payment income requires shop sales and shipping allocations')
    || message.startsWith('Payment income contains invalid shop sales or shipping allocations')
    || message.startsWith('Payment requires positive shop allocations');
};

const scheduleReconnect = () => {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectConsumer();
  }, 5000);
};

const parseMessage = (message: ConsumeMessage): PaymentEvent => {
  const payload: unknown = JSON.parse(message.content.toString('utf8'));
  return normalizePaymentEvent(payload);
};

async function savePaymentJournal(input: {
  referenceType: string;
  referenceId: string;
  eventId: string;
  narration: string;
  lines: ReturnType<typeof buildPaymentJournalLines>;
}) {
  await prisma.$transaction(async (tx) => {
    const existingEntry = await tx.journalEntry.findFirst({
      where: {
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      },
      select: { id: true, eventId: true },
    });
    await createJournalEntryInTransaction({
      ...input,
      eventId: existingEntry?.eventId ?? input.eventId,
    }, tx, existingEntry?.id ?? undefined);
  });
}

const processPaymentCompleted = async (event: PaymentCompletedEvent): Promise<void> => {
  if (!shouldRecognizePaymentEvent(event)) {
    console.log(`COD payment completion deferred until collection: ${event.data.payment_id}`);
    return;
  }

  const projectedShopBreakdown = event.data.shop_breakdown?.length
    ? event.data.shop_breakdown
    : event.data.order_id
      ? await getOrderShopSettlementAllocations(event.data.order_id)
      : [];
  const paymentShopBreakdown = projectedShopBreakdown.map((row) => ({
    ...row,
    shop_id: row.shop_id ?? undefined,
    seller_id: row.seller_id ?? undefined,
  }));
  const paymentContext = {
    payment_id: event.data.payment_id,
    order_id: event.data.order_id,
    checkout_id: event.data.checkout_id,
    amount: event.data.amount,
    currency: event.data.currency,
    shop_id: event.data.shop_id,
    seller_id: event.data.seller_id,
    shop_breakdown: paymentShopBreakdown.length > 0 ? paymentShopBreakdown : undefined,
  };

  const settlement = calculateMarketplaceSettlement(paymentContext);
  await savePaymentSettlement({
    paymentId: event.data.payment_id,
    orderId: event.data.order_id,
    checkoutId: event.data.checkout_id,
    eventId: event.event_id,
    currency: event.data.currency,
    amount: event.data.amount,
  }, settlement.rows);

  if (event.data.order_id || event.data.checkout_id) {
    const revenueAllocations = event.data.order_id
      ? await getOrderShopRevenueAllocations(event.data.order_id)
      : [];
    if (revenueAllocations.length === 0) {
      console.log(`Payment income deferred until order sales projection: ${event.data.payment_id}`);
      return;
    }
    await savePaymentJournal({
      referenceType: 'PAYMENT',
      referenceId: event.data.payment_id,
      eventId: event.event_id,
      narration: `Successful payment for order ${event.data.order_id}`,
      lines: buildMerchandisePaymentJournalLines(
        paymentContext,
        revenueAllocations,
        'Payment received',
      ),
    });
  } else {
    await savePaymentJournal({
      referenceType: 'PAYMENT',
      referenceId: event.data.payment_id,
      eventId: event.event_id,
      narration: 'Successful payment',
      lines: buildPaymentJournalLines(paymentContext),
    });
  }

  console.log(`payment.completed accounted: ${event.data.payment_id}`);
};

const processOrderPaid = async (event: OrderPaidEvent): Promise<void> => {
  const projections = buildPnlOrderShopProjections(event);

  await prisma.$transaction(async (tx) => {
    for (const projection of projections) {
      const { discounts, ...data } = projection;
      await tx.pnlOrderShop.upsert({
        where: {
          orderId_shopId: {
            orderId: projection.orderId,
            shopId: projection.shopId,
          },
        },
        update: {
          ...data,
          discounts: {
            deleteMany: {},
            create: discounts,
          },
        },
        create: {
          ...data,
          discounts: { create: discounts },
        },
      });
    }
  });

  await syncOrderPaidSettlement(event);

  if (!event.data.payment_id) return;
  const settlement = await prisma.paymentSettlement.findUnique({
    where: { paymentReference: event.data.payment_id },
    select: { totalAmount: true, currency: true, eventId: true, status: true },
  });
  if (!settlement || settlement.status !== 'POSTED') return;

  const revenueAllocations = await getOrderShopRevenueAllocations(event.data.order_id);
  if (revenueAllocations.length === 0) {
    throw new Error(`Order sales projection missing for payment ${event.data.payment_id}`);
  }
  const paymentContext: PaymentJournalContext = {
    payment_id: event.data.payment_id,
    order_id: event.data.order_id,
    amount: Number(settlement.totalAmount.toString()),
    currency: settlement.currency,
  };
  await savePaymentJournal({
    referenceType: 'PAYMENT',
    referenceId: event.data.payment_id,
    eventId: settlement.eventId ?? event.event_id,
    narration: `Successful payment for order ${event.data.order_id}`,
    lines: buildMerchandisePaymentJournalLines(
      paymentContext,
      revenueAllocations,
      'Payment received',
    ),
  });
};

export type PaymentCollectedProcessorDependencies = {
  isAlreadyProcessed: (paymentId: string, eventId: string, journalEventId: string) => Promise<boolean>;
  getRevenueAllocations: typeof getOrderShopRevenueAllocations;
  recordBatchExpense: typeof recordCodCollectionBatchExpense;
  saveJournal: typeof savePaymentJournal;
  saveSettlement: typeof savePaymentSettlement;
};

export function buildCollectedPaymentJournalEventId(paymentId: string, eventId: string): string {
  return `payment.collected:${paymentId}:${eventId}`;
}

async function isCollectedPaymentAlreadyProcessed(
  paymentId: string,
  eventId: string,
  journalEventId: string,
): Promise<boolean> {
  const [journal, settlement] = await Promise.all([
    prisma.journalEntry.findFirst({
      where: { referenceType: 'PAYMENT', referenceId: paymentId },
      select: { eventId: true },
    }),
    prisma.paymentSettlement.findUnique({
      where: { paymentReference: paymentId },
      select: { eventId: true },
    }),
  ]);

  return (
    (journal?.eventId === eventId || journal?.eventId === journalEventId)
    && settlement?.eventId === eventId
  );
}

const collectedPaymentProcessorDependencies: PaymentCollectedProcessorDependencies = {
  isAlreadyProcessed: isCollectedPaymentAlreadyProcessed,
  getRevenueAllocations: getOrderShopRevenueAllocations,
  recordBatchExpense: recordCodCollectionBatchExpense,
  saveJournal: savePaymentJournal,
  saveSettlement: savePaymentSettlement,
};

export const processPaymentCollected = async (
  event: PaymentCollectedEvent,
  dependencies: PaymentCollectedProcessorDependencies = collectedPaymentProcessorDependencies,
): Promise<void> => {
  const paymentJournalEventId = buildCollectedPaymentJournalEventId(
    event.data.payment_id,
    event.event_id,
  );
  if (await dependencies.isAlreadyProcessed(
    event.data.payment_id,
    event.event_id,
    paymentJournalEventId,
  )) {
    return;
  }

  if (!event.data.order_id) {
    if (event.data.delivery_expense_group) {
      throw new PermanentShipmentDeliveredEventError('Collect COD batch event is missing its order ID');
    }
    throw new Error('COD payment income requires an order sales projection');
  }

  const revenueAllocations = await dependencies.getRevenueAllocations(event.data.order_id);
  if (revenueAllocations.length === 0) {
    throw new Error(`Order sales projection missing for collected COD payment ${event.data.payment_id}`);
  }
  validateCollectedShopAllocations(event, revenueAllocations);

  const expenseGroup = event.data.delivery_expense_group;
  if (expenseGroup) {
    if (
      !expenseGroup.order_ids.includes(event.data.order_id)
      || !event.data.shop_breakdown.some((row) => row.shop_id === expenseGroup.shop_id)
    ) {
      throw new PermanentShipmentDeliveredEventError('Collect COD event does not match its shop and batch order attribution');
    }
    await dependencies.recordBatchExpense({
      groupId: expenseGroup.group_id,
      shopId: expenseGroup.shop_id,
      deliveryCompanyId: expenseGroup.delivery_company_id,
      orderIds: expenseGroup.order_ids,
      effectiveAt: new Date(expenseGroup.effective_at),
    }, event.event_id);
  }

  const paymentContext: PaymentJournalContext = {
    payment_id: event.data.payment_id,
    order_id: event.data.order_id,
    checkout_id: event.data.checkout_id,
    amount: event.data.amount,
    currency: event.data.currency,
  };
  await dependencies.saveJournal({
    referenceType: 'PAYMENT',
    referenceId: event.data.payment_id,
    eventId: paymentJournalEventId,
    narration: event.data.order_id
      ? `Collected COD payment for order ${event.data.order_id}`
      : 'Collected COD payment',
    lines: buildCollectedPaymentJournalLines(paymentContext, revenueAllocations),
  });

  await dependencies.saveSettlement({
    paymentId: event.data.payment_id,
    orderId: event.data.order_id,
    checkoutId: event.data.checkout_id,
    eventId: event.event_id,
    currency: event.data.currency,
    amount: event.data.amount,
  }, event.data.shop_breakdown.map((row) => ({
    shop_id: row.shop_id,
    gross_amount: row.gross_amount,
    net_payout: row.gross_amount,
  })));

  console.log(`payment.collected accounted: ${event.data.payment_id}`);
};

const processPaymentEvent = async (message: ConsumeMessage): Promise<void> => {
  const event = parseMessage(message);
  if (event.event === 'payment.collected') {
    await processPaymentCollected(event);
  } else if (event.event === 'order.paid') {
    await processOrderPaid(event);
  } else {
    await processPaymentCompleted(event);
  }
};

const ensureSharedExchange = async (activeChannel: Channel): Promise<void> => {
  await activeChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
  console.log(`Ensured shared exchange ${config.rabbitmqExchange} on the configured broker.`);
};

const ensureQueue = async (activeChannel: Channel, queueName: string, options: object): Promise<void> => {
  await activeChannel.assertQueue(queueName, options);
  console.log(`Ensured queue ${queueName} on the configured broker.`);
};

const consumeMessages = async (activeChannel: Channel): Promise<void> => {
  await activeChannel.prefetch(1);
  await activeChannel.consume(config.rabbitmqPaymentQueue, async (message) => {
    if (!message) {
      return;
    }

    try {
      await processPaymentEvent(message);
      activeChannel.ack(message);
    } catch (error) {
      console.error('Failed to process payment event', error);
      activeChannel.nack(message, false, !isPermanentError(error));
    }
  });
};

const connectConsumer = async (): Promise<void> => {
  if (shuttingDown || channel) {
    return;
  }

  let nextConnection: ChannelModel | null = null;
  let nextChannel: Channel | null = null;

  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createChannel();

    await ensureSharedExchange(nextChannel);
    await ensureQueue(nextChannel, config.rabbitmqPaymentDlq, { durable: true });
    await ensureQueue(nextChannel, config.rabbitmqPaymentQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: config.rabbitmqPaymentDlq,
    });
    await nextChannel.bindQueue(
      config.rabbitmqPaymentQueue,
      config.rabbitmqExchange,
      config.rabbitmqPaymentCompletedKey,
    );
    await nextChannel.bindQueue(
      config.rabbitmqPaymentQueue,
      config.rabbitmqExchange,
      config.rabbitmqPaymentCollectedKey,
    );
    await nextChannel.bindQueue(
      config.rabbitmqPaymentQueue,
      config.rabbitmqExchange,
      config.rabbitmqOrderPaidKey,
    );

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) => console.error('Accounting RabbitMQ connection error', error));
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await consumeMessages(nextChannel);
    console.log(`Accounting consumer listening for ${config.rabbitmqPaymentCompletedKey}, ${config.rabbitmqPaymentCollectedKey}, and ${config.rabbitmqOrderPaidKey}`);
  } catch (error) {
    console.error('Accounting RabbitMQ connection failed; retrying in 5 seconds', error);
    if (nextChannel) {
      await nextChannel.close().catch(() => undefined);
    }
    if (nextConnection) {
      await nextConnection.close().catch(() => undefined);
    }
    scheduleReconnect();
  }
};

export const startPaymentConsumer = async (): Promise<void> => {
  shuttingDown = false;
  await connectConsumer();
};

export const closePaymentConsumer = async (): Promise<void> => {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (channel) {
    await channel.close();
  }
  if (connection) {
    await connection.close();
  }
  channel = null;
  connection = null;
};