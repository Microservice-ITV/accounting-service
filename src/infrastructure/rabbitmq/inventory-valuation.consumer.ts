import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { ZodError } from 'zod';
import { config } from '../../config/index.js';
import {
  InventoryValuationConflictError,
  InventoryValuationService,
} from '../../modules/inventory-accounting/inventory-valuation.service.js';
import {
  processWarehouseInventoryEvent,
  WarehouseSourceEventConflictError,
} from '../../modules/inventory-accounting/warehouse-inventory-events.js';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const valuationService = new InventoryValuationService();

export async function dispatchInventoryEvent(
  payload: unknown,
  processValuation: (event: unknown) => Promise<unknown> = (event) => valuationService.process(event),
  processWarehouseEvent: (event: unknown) => Promise<unknown> = processWarehouseInventoryEvent,
): Promise<unknown> {
  if (
    typeof payload === 'object'
    && payload !== null
    && 'event' in payload
    && payload.event === 'inventory.valuation.movement'
  ) {
    return processValuation(payload);
  }
  return processWarehouseEvent(payload);
}

async function handleMessage(activeChannel: Channel, message: ConsumeMessage): Promise<void> {
  try {
    const payload: unknown = JSON.parse(message.content.toString('utf8'));
    await dispatchInventoryEvent(payload);
    // BLOCKED events are durably retained in the inbox for Finance-configured replay.
    activeChannel.ack(message);
  } catch (error) {
    if (
      error instanceof InventoryValuationConflictError
      || error instanceof WarehouseSourceEventConflictError
    ) {
      console.error('Rejecting inventory valuation idempotency conflict', error.message);
      activeChannel.nack(message, false, false);
      return;
    }
    if (error instanceof SyntaxError || error instanceof ZodError) {
      console.error('Rejecting invalid inventory valuation event envelope', error.message);
      activeChannel.nack(message, false, false);
      return;
    }
    console.error('Unable to persist inventory valuation event; message will be retried', error);
    activeChannel.nack(message, false, true);
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
  let nextChannel: Channel | null = null;
  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createChannel();
    await nextChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
    await nextChannel.assertQueue(config.rabbitmqInventoryValuationDlq, { durable: true });
    await nextChannel.assertQueue(config.rabbitmqInventoryValuationQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: config.rabbitmqInventoryValuationDlq,
    });
    await nextChannel.bindQueue(
      config.rabbitmqInventoryValuationQueue,
      config.rabbitmqExchange,
      config.rabbitmqInventoryValuationKey,
    );
    for (const routingKey of [
      config.rabbitmqInventoryUpdatedKey,
      config.rabbitmqInventoryLowStockKey,
      config.rabbitmqPurchaseGoodsReceivedKey,
      config.rabbitmqPurchaseGoodsReturnedKey,
    ]) {
      await nextChannel.bindQueue(
        config.rabbitmqInventoryValuationQueue,
        config.rabbitmqExchange,
        routingKey,
      );
    }
    await nextChannel.prefetch(1);
    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) => console.error('Inventory valuation RabbitMQ error', error));
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });
    await nextChannel.consume(config.rabbitmqInventoryValuationQueue, (message) => {
      if (message) void handleMessage(nextChannel!, message);
    });
    console.log(`Accounting consumer listening for ${config.rabbitmqInventoryValuationKey}`);
  } catch (error) {
    console.error('Inventory valuation consumer failed to connect; retrying in 5 seconds', error);
    if (nextChannel) await nextChannel.close().catch(() => undefined);
    if (nextConnection) await nextConnection.close().catch(() => undefined);
    scheduleReconnect();
  }
}

export async function startInventoryValuationConsumer(): Promise<void> {
  shuttingDown = false;
  await connectConsumer();
}

export async function closeInventoryValuationConsumer(): Promise<void> {
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
