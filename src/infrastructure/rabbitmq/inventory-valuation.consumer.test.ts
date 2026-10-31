import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchInventoryEvent } from './inventory-valuation.consumer.js';

test('dispatches existing Warehouse event types to the source-event inbox', async () => {
  const calls: string[] = [];
  const event = { event: 'purchase.goods_received' };
  await dispatchInventoryEvent(
    event,
    async () => { calls.push('valuation'); },
    async () => { calls.push('warehouse-source'); },
  );
  assert.deepEqual(calls, ['warehouse-source']);
});

test('keeps strict valuation events on the existing valuation processor', async () => {
  const calls: string[] = [];
  const event = { event: 'inventory.valuation.movement' };
  await dispatchInventoryEvent(
    event,
    async () => { calls.push('valuation'); },
    async () => { calls.push('warehouse-source'); },
  );
  assert.deepEqual(calls, ['valuation']);
});
