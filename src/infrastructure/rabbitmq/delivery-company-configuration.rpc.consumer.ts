import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { connect } from 'amqplib';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { deliveryCompanyFeeService } from '../../modules/delivery-company-fees/delivery-company-fee.module.js';

const ROUTING_KEY = 'accounting.delivery-company.configuration.validate';
const QUEUE_NAME = 'accounting.delivery_company_configuration.rpc';

const requestSchema = z.object({
  version: z.literal(1),
  shopId: z.string().trim().min(1).max(64),
  deliveryCompanyId: z.string().trim().min(1),
});

type ConfigurationValidator = (
  shopId: string,
  deliveryCompanyId: string,
) => Promise<boolean>;

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function hasValidServiceKey(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

async function validateConfiguration(
  shopId: string,
  deliveryCompanyId: string,
): Promise<boolean> {
  return deliveryCompanyFeeService.isActiveConfiguration(shopId, deliveryCompanyId);
}

export async function handleDeliveryCompanyConfigurationRequest(
  activeChannel: Channel,
  message: ConsumeMessage,
  validator: ConfigurationValidator = validateConfiguration,
  expectedServiceKey = process.env.ORDER_SERVICE_API_KEY,
): Promise<void> {
  const replyTo = message.properties.replyTo;
  const correlationId = message.properties.correlationId;
  if (!replyTo || !replyTo.startsWith('amq.gen-') || !correlationId) {
    activeChannel.ack(message);
    return;
  }

  let response: { status: 'ok'; valid: boolean } | { status: 'error'; code: string };
  if (!hasValidServiceKey(message.properties.headers?.['x-service-key'], expectedServiceKey)) {
    response = { status: 'error', code: 'unauthorized' };
  } else {
    let parsed: ReturnType<typeof requestSchema.safeParse>;
    try {
      parsed = requestSchema.safeParse(JSON.parse(message.content.toString('utf8')));
    } catch {
      parsed = requestSchema.safeParse(null);
    }
    if (!parsed.success) {
      response = { status: 'error', code: 'invalid_request' };
    } else {
      try {
        response = {
          status: 'ok',
          valid: await validator(
            parsed.data.shopId,
            parsed.data.deliveryCompanyId,
          ),
        };
      } catch (error) {
        console.error('Delivery Company configuration request failed', error);
        response = { status: 'error', code: 'validation_unavailable' };
      }
    }
  }

  activeChannel.sendToQueue(replyTo, Buffer.from(JSON.stringify(response)), {
    contentType: 'application/json',
    correlationId,
  });
  activeChannel.ack(message);
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectConsumer();
  }, 5000);
}

async function connectConsumer(): Promise<void> {
  if (shuttingDown || channel) return;

  let nextConnection: ChannelModel | null = null;
  let nextChannel: Channel | null = null;
  try {
    nextConnection = await connect(config.rabbitmqUrl);
    nextChannel = await nextConnection.createChannel();
    await nextChannel.assertExchange(config.rabbitmqExchange, 'topic', { durable: true });
    await nextChannel.assertQueue(QUEUE_NAME, { durable: true });
    await nextChannel.bindQueue(QUEUE_NAME, config.rabbitmqExchange, ROUTING_KEY);
    await nextChannel.prefetch(10);

    connection = nextConnection;
    channel = nextChannel;
    nextConnection.on('error', (error) => {
      console.error('Delivery Company RPC RabbitMQ connection error', error);
    });
    nextConnection.on('close', () => {
      connection = null;
      channel = null;
      scheduleReconnect();
    });

    await nextChannel.consume(QUEUE_NAME, async (message) => {
      if (!message) return;
      try {
        await handleDeliveryCompanyConfigurationRequest(nextChannel!, message);
      } catch (error) {
        console.error('Failed to respond to Delivery Company RPC request', error);
        nextChannel!.nack(message, false, true);
      }
    });
    console.log('Accounting Delivery Company configuration RPC consumer is listening');
  } catch (error) {
    console.error('Accounting Delivery Company RPC connection failed; retrying in 5 seconds', error);
    if (nextChannel) await nextChannel.close().catch(() => undefined);
    if (nextConnection) await nextConnection.close().catch(() => undefined);
    scheduleReconnect();
  }
}

export async function startDeliveryCompanyConfigurationRpcConsumer(): Promise<void> {
  shuttingDown = false;
  await connectConsumer();
}

export async function closeDeliveryCompanyConfigurationRpcConsumer(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const activeChannel = channel;
  const activeConnection = connection;
  channel = null;
  connection = null;
  if (activeChannel) await activeChannel.close().catch(() => undefined);
  if (activeConnection) await activeConnection.close().catch(() => undefined);
}
