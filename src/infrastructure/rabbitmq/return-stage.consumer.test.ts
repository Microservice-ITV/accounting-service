import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channel } from 'amqplib';
import { config } from '../../config/index.js';
import {
  buildOrderReturnStage,
  configureOrderReturnedQueue,
  handleOrderReturnedPayload,
  normalizeOrderReturnedEvent,
  processOrderReturnedEvent,
  type OrderReturnStageInput,
} from './return-stage.consumer.js';

const returnedEvent = {
  event_id: 'return-event-1',
  event: 'order.returned',
  version: 'v1',
  timestamp: '2026-10-26T10:00:00.000Z',
  producer: 'order-service',
  correlation_id: 'checkout-1',
  data: {
    order_id: 'order-1',
    status: 'RETURNED',
    reason: 'Delivery returned to seller',
    returned_at: '2026-10-26T09:59:00.000Z',
    shop_breakdown: [
      { shop_id: 'shop-1', grand_total: 500 },
      { shop_id: 'shop-2', grand_total: 700 },
      { shop_id: 'shop-1', grand_total: 500 },
    ],
  },
};

test('normalizes the actual order.returned event and does not infer accounting amounts', () => {
  const event = normalizeOrderReturnedEvent(returnedEvent);
  const record = buildOrderReturnStage(event);

  assert.deepEqual(record, {
    id: 'ORDER_RETURNED:order-1',
    eventId: 'return-event-1',
    orderId: 'order-1',
    shopIds: ['shop-1', 'shop-2'],
    reason: 'Delivery returned to seller',
    returnedAt: new Date('2026-10-26T09:59:00.000Z'),
    status: 'RETURNED',
  });
  assert.equal('amount' in record, false);
});

test('persists returned orders idempotently by order ID and stable event ID', async () => {
  const stages = new Map<string, OrderReturnStageInput>();
  const writer = {
    upsertOrderReturn: async (record: OrderReturnStageInput) => {
      stages.set(record.orderId, record);
    },
  };

  await processOrderReturnedEvent(returnedEvent, writer);
  await processOrderReturnedEvent(returnedEvent, writer);
  await processOrderReturnedEvent({
    ...returnedEvent,
    event_id: 'return-event-replay',
  }, writer);

  assert.equal(stages.size, 1);
  assert.equal(stages.get('order-1')?.id, 'ORDER_RETURNED:order-1');
  assert.equal(stages.get('order-1')?.eventId, 'return-event-replay');
});

test('rejects missing return fields and invalid returned timestamps', async () => {
  const noReason = {
    ...returnedEvent,
    data: { ...returnedEvent.data, reason: undefined },
  };
  const invalidDate = {
    ...returnedEvent,
    data: { ...returnedEvent.data, returned_at: 'not-a-date' },
  };
  let writes = 0;
  const writer = {
    upsertOrderReturn: async () => { writes += 1; },
  };

  await assert.rejects(processOrderReturnedEvent(noReason, writer));
  await assert.rejects(processOrderReturnedEvent(invalidDate, writer));
  assert.equal(writes, 0);
});

test('acks persisted events and dead-letters malformed events while retrying transient failures', async () => {
  const outcomes: string[] = [];
  const reportError = () => undefined;
  const writer = {
    upsertOrderReturn: async () => undefined,
  };

  await handleOrderReturnedPayload(
    JSON.stringify(returnedEvent),
    () => outcomes.push('ack'),
    (requeue) => outcomes.push(`nack:${requeue}`),
    writer,
    reportError,
  );
  await handleOrderReturnedPayload(
    JSON.stringify({ ...returnedEvent, data: { order_id: 'order-1' } }),
    () => outcomes.push('ack'),
    (requeue) => outcomes.push(`nack:${requeue}`),
    writer,
    reportError,
  );
  await handleOrderReturnedPayload(
    JSON.stringify(returnedEvent),
    () => outcomes.push('ack'),
    (requeue) => outcomes.push(`nack:${requeue}`),
    { upsertOrderReturn: async () => { throw new Error('Database unavailable'); } },
    reportError,
  );

  assert.deepEqual(outcomes, ['ack', 'nack:false', 'nack:true']);
});

test('binds the configured accounting queue to order.returned with dead-letter routing', async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const fakeChannel = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]); },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]); },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]); },
  } as unknown as Channel;

  await configureOrderReturnedQueue(fakeChannel);

  assert.deepEqual(calls, [
    ['exchange', config.rabbitmqExchange, 'topic', { durable: true }],
    ['queue', config.rabbitmqOrderReturnedDlq, { durable: true }],
    ['queue', config.rabbitmqOrderReturnedQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: config.rabbitmqOrderReturnedDlq,
    }],
    ['bind', config.rabbitmqOrderReturnedQueue, config.rabbitmqExchange, 'order.returned'],
  ]);
});
