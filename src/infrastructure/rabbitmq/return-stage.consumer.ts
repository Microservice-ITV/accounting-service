import type { Channel, ChannelModel } from 'amqplib';
import { connect } from 'amqplib';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { config } from '../../config/index.js';

const orderReturnedEventSchema = z.object({
  event_id: z.string().trim().min(1),
  event: z.literal('order.returned'),
  timestamp: z.string().datetime({ offset: true }).optional(),
  data: z.object({
    order_id: z.string().trim().min(1),
    status: z.literal('RETURNED').optional(),
    reason: z.string().trim().min(1),
    returned_at: z.string().datetime({ offset: true }),
    shop_id: z.string().trim().min(1).optional(),
    shop_breakdown: z.array(z.object({
      shop_id: z.string().trim().min(1),
    }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

export type OrderReturnedEvent = z.infer<typeof orderReturnedEventSchema>;

export type OrderReturnStageInput = {
  id: string;
  eventId: string;
  orderId: string;
  shopIds: string[];
  reason: string;
  returnedAt: Date;
  status: 'RETURNED';
};

export type OrderReturnStageWriter = {
  upsertOrderReturn: (record: OrderReturnStageInput) => Promise<unknown>;
};

export class PermanentOrderReturnedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOrderReturnedEventError';
  }
}

export function normalizeOrderReturnedEvent(raw: unknown): OrderReturnedEvent {
  return orderReturnedEventSchema.parse(raw);
}

export function buildOrderReturnStage(event: OrderReturnedEvent): OrderReturnStageInput {
  const shopIds = new Set([
    ...(event.data.shop_id ? [event.data.shop_id] : []),
    ...(event.data.shop_breakdown ?? []).map((shop) => shop.shop_id),
  ]);

  return {
    id: `ORDER_RETURNED:${event.data.order_id}`,
    eventId: event.event_id,
    orderId: event.data.order_id,
    shopIds: [...shopIds],
    reason: event.data.reason,
    returnedAt: new Date(event.data.returned_at),
    status: 'RETURNED',
  };
}

const prismaWriter: OrderReturnStageWriter = {
  upsertOrderReturn: async (record) => {
    try {
      return await prisma.orderReturnStage.upsert({
        where: { orderId: record.orderId },
        create: record,
        update: {
          eventId: record.eventId,
          shopIds: record.shopIds,
          reason: record.reason,
          returnedAt: record.returnedAt,
          status: record.status,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      const existingOrder = await prisma.orderReturnStage.findUnique({
        where: { orderId: record.orderId },
      });
      if (existingOrder) return existingOrder;

      const existingEvent = await prisma.orderReturnStage.findUnique({
        where: { eventId: record.eventId },
        select: { orderId: true },
      });
      if (existingEvent) {
        throw new PermanentOrderReturnedEventError(
          `Event ${record.eventId} is already associated with order ${existingEvent.orderId}`,
        );
      }

      throw error;
    }
  },
};

export async function processOrderReturnedEvent(
  raw: unknown,
  writer: OrderReturnStageWriter = prismaWriter,
): Promise<OrderReturnStageInput> {
  const record = buildOrderReturnStage(normalizeOrderReturnedEvent(raw));
  await writer.upsertOrderReturn(record);
  return record;
}

export async function handleOrderReturnedPayload(
  content: string,
  acknowledge: () => void,
  reject: (requeue: boolean) => void,
  writer: OrderReturnStageWriter = prismaWriter,
  reportError: (error: unknown) => void = (error) =>
    console.error('Failed to project order.returned event', error),
): Promise<void> {
  try {
    await processOrderReturnedEvent(JSON.parse(content) as unknown, writer);
    acknowledge();
  } catch (error) {
    reportError(error);
    const isPermanent = error instanceof z.ZodError
      || error instanceof SyntaxError
      || error instanceof PermanentOrderReturnedEventError;
    reject(!isPermanent);
  }
}

export async function configureOrderReturnedQueue(channel: Channel): Promise<void> {
  await channel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
  await channel.assertQueue(config.rabbitmqOrderReturnedDlq, { durable: true });
  await channel.assertQueue(config.rabbitmqOrderReturnedQueue, {
    durable: true,
    deadLetterExchange: '',
    deadLetterRoutingKey: config.rabbitmqOrderReturnedDlq,
  });
  await channel.bindQueue(
    config.rabbitmqOrderReturnedQueue,
    config.rabbitmqExchange,
    config.rabbitmqOrderReturnedKey,
  );
}

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

const scheduleReconnect = (): void => {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectConsumer();
  }, 5000);
};

const consumeMessages = async (activeChannel: Channel): Promise<void> => {
  await activeChannel.prefetch(1);
  await activeChannel.consume(config.rabbitmqOrderReturnedQueue, (message) => {
    if (!message) return;

    void handleOrderReturnedPayload(
      message.content.toString('utf8'),
      () => activeChannel.ack(message),
      (requeue) => activeChannel.nack(message, false, requeue),
    );
  });
};

const connectConsumer = async (): Promise<void> => {
  if (shuttingDown || channel) return;

  let nextConnection: ChannelModel | null = null;
  let nextChannel: Channel | null = null;
  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createChannel();
    await configureOrderReturnedQueue(nextChannel);

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) =>
      console.error('Accounting order-returned RabbitMQ connection error', error)
    );
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await consumeMessages(nextChannel);
    console.log(`Accounting consumer listening for ${config.rabbitmqOrderReturnedKey}`);
  } catch (error) {
    console.error('Accounting order-returned consumer failed to connect; retrying in 5 seconds', error);
    if (nextChannel) await nextChannel.close().catch(() => undefined);
    if (nextConnection) await nextConnection.close().catch(() => undefined);
    scheduleReconnect();
  }
};

export async function startOrderReturnedConsumer(): Promise<void> {
  shuttingDown = false;
  await connectConsumer();
}

export async function closeOrderReturnedConsumer(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (channel) await channel.close();
  if (connection) await connection.close();
  channel = null;
  connection = null;
}
