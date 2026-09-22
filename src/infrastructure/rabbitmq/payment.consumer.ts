import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { createJournalEntry } from '../../modules/entries/entry.service.js';
import { config } from '../../config/index.js';

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
    status: z.enum(['SUCCESS', 'COMPLETED', 'succeeded', 'completed']).optional(),
    shop_id: z.string().min(1).optional(),
    seller_id: z.string().min(1).optional(),
    shop_breakdown: z.array(shopBreakdownLineSchema).optional(),
  }).passthrough(),
});

type PaymentCompletedEvent = z.infer<typeof paymentCompletedSchema>;

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
    net_payout?: number;
  }>;
};

export function normalizePaymentCompletedEvent(raw: unknown): PaymentCompletedEvent {
  const payload = paymentCompletedSchema.parse(raw);
  return payload;
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

const isPermanentError = (error: unknown): boolean => {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return true;
  }

  const message = error instanceof Error ? error.message : '';
  return message.startsWith('Unknown account codes:') || message.startsWith('Journal entry is out of balance:');
};

const isDuplicateEvent = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
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

const parseMessage = (message: ConsumeMessage): PaymentCompletedEvent => {
  const payload: unknown = JSON.parse(message.content.toString('utf8'));
  return normalizePaymentCompletedEvent(payload);
};

const processPaymentCompleted = async (message: ConsumeMessage): Promise<void> => {
  const event = parseMessage(message);
  const existingEntry = await prisma.journalEntry.findUnique({
    where: { eventId: event.event_id },
  });

  if (existingEntry) {
    console.log(`payment.completed already processed: ${event.event_id}`);
    return;
  }

  const paymentContext = {
    payment_id: event.data.payment_id,
    order_id: event.data.order_id,
    checkout_id: event.data.checkout_id,
    amount: event.data.amount,
    currency: event.data.currency,
    shop_id: event.data.shop_id,
    seller_id: event.data.seller_id,
    shop_breakdown: event.data.shop_breakdown,
  };

  await createJournalEntry({
    referenceType: 'PAYMENT',
    referenceId: event.data.payment_id,
    eventId: event.event_id,
    narration: event.data.order_id ? `Successful payment for order ${event.data.order_id}` : 'Successful payment',
    lines: buildPaymentJournalLines(paymentContext),
  });

  const settlementRows = calculateMarketplaceSettlement(paymentContext).rows;
  if (settlementRows.length > 0) {
    // Store settlement metadata without creating financial journal entries.
    const settlementRecord = await prisma.paymentSettlement.upsert({
      where: { paymentReference: event.data.payment_id },
      update: {
        orderId: event.data.order_id ?? null,
        checkoutId: event.data.checkout_id ?? null,
        eventId: event.event_id,
        currency: event.data.currency ?? 'USD',
        totalAmount: event.data.amount,
        sellerPayableAmount: calculateMarketplaceSettlement(paymentContext).totalPayable,
      },
      create: {
        paymentReference: event.data.payment_id,
        orderId: event.data.order_id ?? null,
        checkoutId: event.data.checkout_id ?? null,
        eventId: event.event_id,
        currency: event.data.currency ?? 'USD',
        totalAmount: event.data.amount,
        sellerPayableAmount: calculateMarketplaceSettlement(paymentContext).totalPayable,
      },
    });

    await prisma.paymentSettlementLine.createMany({
      data: settlementRows.map((row) => ({
        settlementId: settlementRecord.id,
        shopId: row.shop_id ?? null,
        sellerId: row.seller_id ?? null,
        grossAmount: row.gross_amount,
        payableAmount: row.payable_amount,
        currency: event.data.currency ?? 'USD',
      })),
    });

    // The settlement journal is intentionally not created here because the actual payment was already posted as CASH DEBIT / REVENUE CREDIT.
    // This keeps PaymentSettlement and PaymentSettlementLine as traceability metadata only.
  }

  console.log(`payment.completed accounted: ${event.data.payment_id}`);
};

const ensureSharedExchange = async (activeChannel: Channel): Promise<void> => {
  try {
    await activeChannel.checkExchange(config.rabbitmqExchange);
    console.log(`Using existing shared exchange ${config.rabbitmqExchange} on the configured broker; no redeclaration attempted.`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing = /404|NOT_FOUND|not found/i.test(message);

    if (!isMissing) {
      throw error;
    }

    await activeChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
    console.log(`Created missing shared exchange ${config.rabbitmqExchange}.`);
  }
};

const ensureQueue = async (activeChannel: Channel, queueName: string, options: object): Promise<void> => {
  try {
    await activeChannel.checkQueue(queueName);
    console.log(`Using existing queue ${queueName} on the configured broker; no redeclaration attempted.`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing = /404|NOT_FOUND|not found/i.test(message);

    if (!isMissing) {
      throw error;
    }

    await activeChannel.assertQueue(queueName, options);
    console.log(`Created missing queue ${queueName}.`);
  }
};

const consumeMessages = async (activeChannel: Channel): Promise<void> => {
  await activeChannel.prefetch(10);
  await activeChannel.consume(config.rabbitmqPaymentQueue, async (message) => {
    if (!message) {
      return;
    }

    try {
      await processPaymentCompleted(message);
      activeChannel.ack(message);
    } catch (error) {
      if (isDuplicateEvent(error)) {
        activeChannel.ack(message);
        console.log('Duplicate payment.completed ignored');
        return;
      }

      console.error('Failed to process payment.completed', error);
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

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) => console.error('Accounting RabbitMQ connection error', error));
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await consumeMessages(nextChannel);
    console.log(`Accounting consumer listening for ${config.rabbitmqPaymentCompletedKey}`);
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