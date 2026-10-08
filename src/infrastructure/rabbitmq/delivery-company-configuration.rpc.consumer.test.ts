import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channel, ConsumeMessage } from 'amqplib';
import { handleDeliveryCompanyConfigurationRequest } from './delivery-company-configuration.rpc.consumer.js';

const requestBody = JSON.stringify({
  version: 1,
  shopId: 'shop-1',
  deliveryCompanyId: 'company-1',
});

function makeMessage(
  body = requestBody,
  headers: Record<string, unknown> = { 'x-service-key': 'shared-key' },
): ConsumeMessage {
  return {
    content: Buffer.from(body),
    fields: {} as ConsumeMessage['fields'],
    properties: {
      headers,
      replyTo: 'amq.gen-order-reply',
      correlationId: 'request-correlation-1',
    } as ConsumeMessage['properties'],
  };
}

function makeChannel() {
  const replies: Array<{ queue: string; body: string; properties: Record<string, unknown> }> = [];
  const acknowledged: ConsumeMessage[] = [];
  const channel = {
    sendToQueue: (queue: string, body: Buffer, properties: Record<string, unknown>) => {
      replies.push({ queue, body: body.toString('utf8'), properties });
      return true;
    },
    ack: (message: ConsumeMessage) => acknowledged.push(message),
  } as unknown as Channel;
  return { channel, replies, acknowledged };
}

test('accepts the canonical shop and Delivery Company identity', async () => {
  const { channel, replies, acknowledged } = makeChannel();
  const validated: Array<[string, string]> = [];

  await handleDeliveryCompanyConfigurationRequest(
    channel,
    makeMessage(JSON.stringify({
      version: 1,
      shopId: 'shop-1',
      deliveryCompanyId: 'company-1',
    })),
    async (...identity) => {
      validated.push(identity);
      return true;
    },
    'shared-key',
  );

  assert.deepEqual(validated, [['shop-1', 'company-1']]);
  assert.equal(JSON.parse(replies[0].body).valid, true);
  assert.equal(replies[0].properties.correlationId, 'request-correlation-1');
  assert.equal(acknowledged.length, 1);
});

test('rejects an invalid or missing service key without invoking validation', async () => {
  const { channel, replies } = makeChannel();
  let validationCalled = false;

  await handleDeliveryCompanyConfigurationRequest(
    channel,
    makeMessage(requestBody, {}),
    async () => {
      validationCalled = true;
      return true;
    },
    'shared-key',
  );

  assert.equal(validationCalled, false);
  assert.deepEqual(JSON.parse(replies[0].body), { status: 'error', code: 'unauthorized' });
});

test('returns a negative validation result without accepting the selection', async () => {
  const { channel, replies } = makeChannel();
  await handleDeliveryCompanyConfigurationRequest(channel, makeMessage(), async () => false, 'shared-key');
  assert.deepEqual(JSON.parse(replies[0].body), { status: 'ok', valid: false });
});

test('rejects malformed Delivery Company configuration requests', async () => {
  const { channel, replies } = makeChannel();
  await handleDeliveryCompanyConfigurationRequest(channel, makeMessage('{}'), async () => true, 'shared-key');
  assert.deepEqual(JSON.parse(replies[0].body), { status: 'error', code: 'invalid_request' });
});

test('rejects malformed JSON without requeueing the request', async () => {
  const { channel, replies, acknowledged } = makeChannel();
  await handleDeliveryCompanyConfigurationRequest(
    channel,
    makeMessage('{'),
    async () => true,
    'shared-key',
  );
  assert.deepEqual(JSON.parse(replies[0].body), { status: 'error', code: 'invalid_request' });
  assert.equal(acknowledged.length, 1);
});
