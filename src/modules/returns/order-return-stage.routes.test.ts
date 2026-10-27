import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { test } from 'node:test';
import {
  createOrderReturnStageRouter,
  type OrderReturnStageResponse,
} from './order-return-stage.routes.js';

test('returns persisted ORDER_RETURNED records through the Accounting API', async () => {
  const returnedAt = new Date('2026-10-26T09:59:00.000Z');
  const record: OrderReturnStageResponse = {
    id: 'ORDER_RETURNED:order-1',
    referenceType: 'ORDER_RETURNED',
    referenceId: 'order-1',
    eventId: 'return-event-1',
    orderId: 'order-1',
    shopId: 'shop-1, shop-2',
    reason: 'Delivery returned to seller',
    returnedAt,
    status: 'RETURNED',
  };
  const app = express();
  const orderReturnRouter = createOrderReturnStageRouter(async () => [record]);
  app.use('/api/v1', orderReturnRouter);
  app.use('/api/v1/entries', orderReturnRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    for (const path of ['/api/v1/returns', '/api/v1/entries/returns']) {
      const apiResponse: Awaited<ReturnType<typeof fetch>> = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(apiResponse.status, 200);
      assert.deepEqual(await apiResponse.json(), [{
        ...record,
        returnedAt: returnedAt.toISOString(),
      }]);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
