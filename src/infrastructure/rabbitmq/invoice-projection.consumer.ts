import {
  ConfirmChannel,
  ConsumeMessage,
  ChannelModel,
  connect,
} from 'amqplib';
import { ZodError } from 'zod';
import { config } from '../../config/index.js';
import {
  InvoiceProjectionConflictError,
  InvoiceProjectionRepository,
} from '../../modules/ar-ap/repositories/invoice-projection.repository.js';
import { InvoiceProjectionService } from '../../modules/ar-ap/services/invoice-projection.service.js';

type MessageRelay = {
  ack(message: ConsumeMessage): void;
  nack(message: ConsumeMessage, allUpTo: boolean, requeue: boolean): void;
  sendToQueue(
    queue: string,
    content: Buffer,
    options: { persistent: boolean; headers?: Record<string, number> },
    callback: (error: Error | null) => void,
  ): boolean;
};

const invoiceProjectionService = new InvoiceProjectionService(
  new InvoiceProjectionRepository(),
);

let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

const invoiceRoutingKeys = [
  config.rabbitmqInvoiceGeneratedKey,
  config.rabbitmqInvoicePaidKey,
];

function isPermanentError(error: unknown): boolean {
  return error instanceof SyntaxError
    || error instanceof ZodError
    || error instanceof InvoiceProjectionConflictError;
}

function retryCount(message: ConsumeMessage): number {
  const value = message.properties.headers?.['x-accounting-retry-count'];
  const count = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function safeEventMetadata(payload: unknown) {
  if (typeof payload !== 'object' || payload === null) return {};
  const record = payload as Record<string, unknown>;
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
  return {
    eventId: typeof record.event_id === 'string' ? record.event_id : undefined,
    eventType: typeof record.event === 'string' ? record.event : undefined,
    invoiceId: typeof data.invoice_id === 'string' ? data.invoice_id : undefined,
  };
}

function publishConfirmed(
  activeChannel: MessageRelay,
  queue: string,
  message: ConsumeMessage,
  headers?: Record<string, number>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    activeChannel.sendToQueue(
      queue,
      message.content,
      { persistent: true, ...(headers ? { headers } : {}) },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

export async function handleInvoiceProjectionMessage(
  activeChannel: MessageRelay,
  message: ConsumeMessage,
  processEvent: (payload: unknown) => Promise<{
    eventId: string;
    invoiceId: string;
    result: string;
  }> = (payload) => invoiceProjectionService.processEvent(payload),
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString('utf8')) as unknown;
    const result = await processEvent(payload);
    activeChannel.ack(message);
    console.log(JSON.stringify({
      message: 'invoice_projection_processed',
      eventId: result.eventId,
      invoiceId: result.invoiceId,
      result: result.result,
    }));
  } catch (error) {
    const metadata = safeEventMetadata(payload);
    const permanent = isPermanentError(error);
    const attempt = retryCount(message);
    const deadLetter = permanent || attempt >= config.rabbitmqInvoiceProjectionMaxRetries;

    try {
      if (deadLetter) {
        await publishConfirmed(activeChannel, config.rabbitmqInvoiceProjectionDlq, message);
        activeChannel.ack(message);
        console.error(JSON.stringify({
          message: permanent
            ? 'invoice_projection_event_rejected'
            : 'invoice_projection_retry_limit_reached',
          ...metadata,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        return;
      }

      await publishConfirmed(
        activeChannel,
        config.rabbitmqInvoiceProjectionRetryQueue,
        message,
        { 'x-accounting-retry-count': attempt + 1 },
      );
      activeChannel.ack(message);
      console.error(JSON.stringify({
        message: 'invoice_projection_event_retry_scheduled',
        ...metadata,
        retryCount: attempt + 1,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }));
    } catch (relayError) {
      console.error(JSON.stringify({
        message: 'invoice_projection_relay_failed',
        ...metadata,
        errorType: relayError instanceof Error ? relayError.name : 'UnknownError',
      }));
      activeChannel.nack(message, false, true);
    }
  }
}

export async function configureInvoiceProjectionQueues(activeChannel: ConfirmChannel): Promise<void> {
  if (
    !Number.isInteger(config.rabbitmqInvoiceProjectionRetryDelayMs)
    || config.rabbitmqInvoiceProjectionRetryDelayMs < 1
    || !Number.isInteger(config.rabbitmqInvoiceProjectionMaxRetries)
    || config.rabbitmqInvoiceProjectionMaxRetries < 0
  ) {
    throw new Error('Invoice projection retry settings are invalid');
  }

  await activeChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
  await activeChannel.assertQueue(config.rabbitmqInvoiceProjectionDlq, { durable: true });
  await activeChannel.assertQueue(config.rabbitmqInvoiceProjectionRetryQueue, {
    durable: true,
    arguments: {
      'x-message-ttl': config.rabbitmqInvoiceProjectionRetryDelayMs,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': config.rabbitmqInvoiceProjectionQueue,
    },
  });
  await activeChannel.assertQueue(config.rabbitmqInvoiceProjectionQueue, { durable: true });
  for (const routingKey of invoiceRoutingKeys) {
    await activeChannel.bindQueue(
      config.rabbitmqInvoiceProjectionQueue,
      config.rabbitmqExchange,
      routingKey,
    );
  }
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectConsumer();
  }, 5_000);
}

async function connectConsumer(): Promise<void> {
  if (shuttingDown || channel) return;
  let nextConnection: ChannelModel | null = null;
  let nextChannel: ConfirmChannel | null = null;
  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createConfirmChannel();
    await configureInvoiceProjectionQueues(nextChannel);
    await nextChannel.prefetch(1);

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) =>
      console.error(JSON.stringify({ message: 'invoice_projection_rabbitmq_error', errorType: error.name })),
    );
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await nextChannel.consume(config.rabbitmqInvoiceProjectionQueue, (message) => {
      if (message) void handleInvoiceProjectionMessage(nextChannel!, message);
    });
    console.log(JSON.stringify({
      message: 'invoice_projection_consumer_started',
      queue: config.rabbitmqInvoiceProjectionQueue,
      routingKeys: invoiceRoutingKeys,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      message: 'invoice_projection_consumer_connect_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }));
    if (nextChannel) await nextChannel.close().catch(() => undefined);
    if (nextConnection) await nextConnection.close().catch(() => undefined);
    scheduleReconnect();
  }
}

export async function startInvoiceProjectionConsumer(): Promise<void> {
  shuttingDown = false;
  await connectConsumer();
}

export async function closeInvoiceProjectionConsumer(): Promise<void> {
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
