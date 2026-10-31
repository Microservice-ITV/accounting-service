import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { config } from '../../config/index.js';
import {
  configureInvoiceProjectionQueues,
  handleInvoiceProjectionMessage,
} from './invoice-projection.consumer.js';

function message(content: string, headers: Record<string, number> = {}): ConsumeMessage {
  return {
    content: Buffer.from(content),
    properties: { headers },
    fields: { routingKey: config.rabbitmqInvoiceGeneratedKey },
  } as unknown as ConsumeMessage;
}

function relay() {
  const calls: Array<{ kind: string; queue?: string; headers?: Record<string, number> }> = [];
  const channel = {
    ack: () => calls.push({ kind: 'ack' }),
    nack: (_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) =>
      calls.push({ kind: requeue ? 'nack-requeue' : 'nack' }),
    sendToQueue: (
      queue: string,
      _content: Buffer,
      options: { headers?: Record<string, number> },
      callback: (error: Error | null) => void,
    ) => {
      calls.push({ kind: 'publish', queue, headers: options.headers });
      callback(null);
      return true;
    },
  };
  return { channel, calls };
}

test('malformed invoice event is sent to DLQ and acknowledged without crashing', async () => {
  const { channel, calls } = relay();

  await handleInvoiceProjectionMessage(channel, message('{not-json'));

  assert.deepEqual(calls.map((call) => call.kind), ['publish', 'ack']);
  assert.equal(calls[0]?.queue, config.rabbitmqInvoiceProjectionDlq);
});

test('transient projection errors are sent to delayed retry queue before ack', async () => {
  const { channel, calls } = relay();
  const notification = JSON.stringify({ event: 'invoice.generated', event_id: 'event-1' });

  await handleInvoiceProjectionMessage(
    channel,
    message(notification),
    async () => { throw new Error('temporary database outage'); },
  );

  assert.deepEqual(calls.map((call) => call.kind), ['publish', 'ack']);
  assert.equal(calls[0]?.queue, config.rabbitmqInvoiceProjectionRetryQueue);
  assert.equal(calls[0]?.headers?.['x-accounting-retry-count'], 1);
});

test('retry limit routes events to DLQ', async () => {
  const { channel, calls } = relay();

  await handleInvoiceProjectionMessage(
    channel,
    message('{}', { 'x-accounting-retry-count': config.rabbitmqInvoiceProjectionMaxRetries }),
    async () => { throw new Error('temporary database outage'); },
  );

  assert.equal(calls[0]?.queue, config.rabbitmqInvoiceProjectionDlq);
  assert.equal(calls.at(-1)?.kind, 'ack');
});

test('invoice projection queue is durable and binds only the invoice notification keys', async () => {
  const calls: unknown[][] = [];
  const activeChannel = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]); },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]); },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]); },
  } as unknown as ConfirmChannel;

  await configureInvoiceProjectionQueues(activeChannel);

  assert.ok(calls.some((call) => call[0] === 'queue'
    && call[1] === config.rabbitmqInvoiceProjectionQueue
    && (call[2] as { durable?: boolean }).durable === true));
  assert.ok(calls.some((call) => call[0] === 'queue'
    && call[1] === config.rabbitmqInvoiceProjectionRetryQueue
    && (call[2] as { arguments?: Record<string, unknown> }).arguments?.['x-message-ttl']
      === config.rabbitmqInvoiceProjectionRetryDelayMs));
  assert.deepEqual(
    calls.filter((call) => call[0] === 'bind').map((call) => call[3]),
    [config.rabbitmqInvoiceGeneratedKey, config.rabbitmqInvoicePaidKey],
  );
});
