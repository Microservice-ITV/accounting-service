import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { Request, RequestHandler } from 'express';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import {
  type IInvoiceProjectionRepository,
  type InvoiceProjectionFilters,
  InvoiceProjectionService,
} from './services/invoice-projection.service.js';
import { createInvoiceProjectionRouter } from './invoice-projection.routes.js';

const shopContext = (shopId = 'shop-1'): AuthenticatedExpenseContext => ({
  userId: 'seller-1',
  role: 'shop_admin',
  activeShopId: shopId,
  authorizedShopIds: [shopId],
  shops: [],
});

test('invoice snapshot API applies authorized shop, status, currency, and date filters', async () => {
  let receivedFilters: InvoiceProjectionFilters | undefined;
  const repository: IInvoiceProjectionRepository = {
    applyEvent: async () => 'CREATED',
    list: async (filters) => {
      receivedFilters = filters;
      return {
        invoices: [{
          invoiceId: 'invoice-1',
          invoiceNumber: 'INV-001',
          orderId: 'order-1',
          shopId: 'shop-1',
          customerId: 'customer-1',
          invoiceDate: new Date('2026-10-30T16:00:00.000Z'),
          paymentMethod: 'CARD',
          observedStatus: 'UNPAID',
          currency: 'MMK',
          invoiceTotal: '100.00',
          statusObservedAt: new Date('2026-10-30T16:30:00.000Z'),
        }],
        total: 1,
      };
    },
  };
  const app = express();
  const authMiddleware: RequestHandler = (req, _res, next) => {
    (req as Request & { auth?: AuthenticatedExpenseContext }).auth = shopContext();
    next();
  };
  app.use('/api/v1', createInvoiceProjectionRouter(
    new InvoiceProjectionService(repository),
    authMiddleware,
  ));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/reports/ar-ap/invoices?status=UNPAID&currency=mmk&invoiceDateFrom=2026-10-30&invoiceDateTo=2026-10-30`,
    );
    const payload = await response.json() as {
      invoices: Array<{ invoiceTotal: string; observedStatus: string }>;
      financialMeaning: { invoiceTotalIsOutstanding: boolean; invoiceAgingAvailable: boolean };
    };

    assert.equal(response.status, 200);
    assert.deepEqual(receivedFilters?.shopIds, ['shop-1']);
    assert.equal(receivedFilters?.status, 'UNPAID');
    assert.equal(receivedFilters?.currency, 'MMK');
    assert.equal(receivedFilters?.invoiceDateFrom?.toISOString(), '2026-10-30T00:00:00.000Z');
    assert.equal(receivedFilters?.invoiceDateToExclusive?.toISOString(), '2026-10-31T00:00:00.000Z');
    assert.equal(payload.invoices[0]?.invoiceTotal, '100.00');
    assert.equal(payload.invoices[0]?.observedStatus, 'UNPAID');
    assert.equal(payload.financialMeaning.invoiceTotalIsOutstanding, false);
    assert.equal(payload.financialMeaning.invoiceAgingAvailable, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test('invoice snapshot API rejects requests for shops outside the authenticated scope', async () => {
  const repository: IInvoiceProjectionRepository = {
    applyEvent: async () => 'CREATED',
    list: async () => ({ invoices: [], total: 0 }),
  };
  const app = express();
  const authMiddleware: RequestHandler = (req, _res, next) => {
    (req as Request & { auth?: AuthenticatedExpenseContext }).auth = shopContext();
    next();
  };
  app.use('/api/v1', createInvoiceProjectionRouter(
    new InvoiceProjectionService(repository),
    authMiddleware,
  ));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/reports/ar-ap/invoices?shopId=shop-2`,
    );
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
