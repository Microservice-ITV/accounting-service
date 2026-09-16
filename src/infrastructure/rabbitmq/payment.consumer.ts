import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { z } from 'zod';
import prisma from '../../lib/prisma.js';
import { createJournalEntry } from '../../modules/entries/entry.service.js';
import { config } from '../../config/index.js';

const paymentCompletedSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('payment.completed'),
  data: z.object({
    payment_id: z.string().min(1),
    amount: z.number().finite().positive(),
    currency: z.string().min(1).optional(),
    status: z.enum(['SUCCESS', 'COMPLETED', 'succeeded', 'completed']).optional(),
  }),
});

type PaymentCompletedEvent = z.infer<typeof paymentCompletedSchema>;

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
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
  return paymentCompletedSchema.parse(payload);
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

  await createJournalEntry({
    referenceType: 'PAYMENT',
    referenceId: event.data.payment_id,
    eventId: event.event_id,
    narration: 'Successful payment',
    lines: [
      {
        accountCode: '1000',
        direction: 'DEBIT',
        amount: event.data.amount,
        memo: event.data.currency ? `Payment received (${event.data.currency})` : 'Payment received',
      },
      {
        accountCode: '4000',
        direction: 'CREDIT',
        amount: event.data.amount,
        memo: event.data.currency ? `Revenue recognized (${event.data.currency})` : 'Revenue recognized',
      },
    ],
  });

  console.log(`payment.completed accounted: ${event.data.payment_id}`);
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

    await nextChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
    await nextChannel.assertQueue(config.rabbitmqPaymentDlq, { durable: true });
    await nextChannel.assertQueue(config.rabbitmqPaymentQueue, {
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