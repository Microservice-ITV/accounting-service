import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { Request, RequestHandler } from 'express';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import { createInventoryAccountingRouter } from './inventory-accounting.routes.js';
import type { InventoryValuationService } from './inventory-valuation.service.js';

const sellerContext: AuthenticatedExpenseContext = {
  userId: 'seller-1',
  role: 'seller',
  activeShopId: 'shop-1',
  authorizedShopIds: ['shop-1', 'shop-2'],
  shops: [],
};

function authAs(context: AuthenticatedExpenseContext): RequestHandler {
  return (req, _res, next) => {
    (req as Request & { auth?: AuthenticatedExpenseContext }).auth = context;
    next();
  };
}

async function withServer(run: (baseUrl: string) => Promise<void>, router: express.Router): Promise<void> {
  const app = express();
  app.use('/api/v1', router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('inventory valuation report applies seller scope and date, warehouse, and SKU filters', async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    getReport: async (params: Record<string, unknown>) => {
      received = params;
      return { complete: false, missingComponents: [], metrics: {}, valuation: [] };
    },
  } as unknown as InventoryValuationService;
  const router = createInventoryAccountingRouter(authAs(sellerContext), service);

  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/reports/inventory-valuation?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-31T00%3A00%3A00.000Z&shop_id=shop-2&warehouse_id=warehouse-1&sku=SKU-1`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      shopIds: ['shop-2'],
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T00:00:00.000Z'),
      warehouseId: 'warehouse-1',
      sku: 'SKU-1',
      historyPage: 1,
      historyPageSize: 20,
    });

    const forbidden = await fetch(`${baseUrl}/reports/inventory-valuation?shop_id=shop-3`);
    assert.equal(forbidden.status, 403);
    const allAuthorized = await fetch(
      `${baseUrl}/reports/inventory-valuation?shop_ids=shop-1%2Cshop-2&page=2&page_size=10`,
    );
    assert.equal(allAuthorized.status, 200);
    assert.deepEqual(received, {
      shopIds: ['shop-1', 'shop-2'],
      historyPage: 2,
      historyPageSize: 10,
    });
    const partlyForbidden = await fetch(
      `${baseUrl}/reports/inventory-valuation?shop_ids=shop-1%2Cshop-3`,
    );
    assert.equal(partlyForbidden.status, 403);
  }, router);
});

test('inventory account mappings require Finance write permission, not a seller role name', async () => {
  let saved = false;
  const service = {
    setAccountMapping: async () => {
      saved = true;
      return {};
    },
  } as unknown as InventoryValuationService;
  const router = createInventoryAccountingRouter(authAs(sellerContext), service);

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/inventory/account-mappings/INVENTORY_ASSET`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });
    assert.equal(response.status, 403);
    assert.equal(saved, false);
  }, router);
});
