import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  requireDeliveryCompanyConfigurationAccess,
  requireExpenseAuth,
} from './auth.js';

const originalFetch = globalThis.fetch;
const originalOrderServiceApiKey = process.env.ORDER_SERVICE_API_KEY;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOrderServiceApiKey === undefined) {
    delete process.env.ORDER_SERVICE_API_KEY;
  } else {
    process.env.ORDER_SERVICE_API_KEY = originalOrderServiceApiKey;
  }
});

function invokeShopConfigurationAccess(
  options: { shopId: string; authorization?: string; serviceKey?: string },
): Promise<{ statusCode: number; body: unknown; nextCalled: boolean }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.serviceKey ? { 'x-service-key': options.serviceKey } : {}),
    };
    const request = {
      headers,
      params: { shopId: options.shopId },
      header: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;
    const response = {
      statusCode: 200,
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      json(body: unknown) {
        resolve({ statusCode: this.statusCode, body, nextCalled: false });
        return this;
      },
    } as Response & { statusCode: number };

    requireDeliveryCompanyConfigurationAccess(request, response, () => {
      resolve({ statusCode: response.statusCode, body: undefined, nextCalled: true });
    });
  });
}

function mockAuthContext(context: unknown) {
  globalThis.fetch = async () => new Response(JSON.stringify(context), { status: 200 });
}

test('rejects approval requests without authentication', async () => {
  const result = await new Promise<{ statusCode: number; body: unknown }>((resolve) => {
    const response = {
      statusCode: 200,
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      json(body: unknown) {
        resolve({ statusCode: this.statusCode, body });
      },
    } as Response & { statusCode: number };

    requireExpenseAuth({ headers: {} } as Request, response, () => {
      resolve({ statusCode: 200, body: 'next' });
    });
  });

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: 'Unauthenticated' });
});

test('allows a seller to read Delivery Company configuration for an authorized shop', async () => {
  mockAuthContext({
    user: { id: 'seller-1', role: 'shop_owner' },
    access_context: {
      active_shop: { shop_id: 'shop-1' },
      shops: [{ shop_id: 'shop-1' }],
    },
  });

  const result = await invokeShopConfigurationAccess({
    shopId: 'shop-1',
    authorization: 'Bearer seller-token',
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('denies a seller access to another shop Delivery Company configuration', async () => {
  process.env.ORDER_SERVICE_API_KEY = 'configured-internal-key';
  mockAuthContext({
    user: { id: 'seller-1', role: 'shop_owner' },
    access_context: {
      active_shop: { shop_id: 'shop-1' },
      shops: [{ shop_id: 'shop-1' }],
    },
  });

  const result = await invokeShopConfigurationAccess({
    shopId: 'shop-2',
    authorization: 'Bearer seller-token',
    serviceKey: 'invalid-internal-key',
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, { error: 'User is not authorized for the selected shop' });
});

test('allows authorized platform finance and Super Admin roles to read any shop configuration', async () => {
  for (const role of ['platform_finance', 'super_admin']) {
    mockAuthContext({
      user: { id: `${role}-user`, role },
      access_context: {
        active_shop: null,
        shops: [],
        platform_roles: [{ code: role }],
      },
    });

    const result = await invokeShopConfigurationAccess({
      shopId: 'shop-2',
      authorization: `Bearer ${role}-token`,
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, 200);
  }
});

test('allows Order Service internal access only with its configured service key', async () => {
  process.env.ORDER_SERVICE_API_KEY = 'configured-internal-key';

  const result = await invokeShopConfigurationAccess({
    shopId: 'shop-2',
    serviceKey: 'configured-internal-key',
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('rejects a normal request with an invalid service key', async () => {
  process.env.ORDER_SERVICE_API_KEY = 'configured-internal-key';

  const result = await invokeShopConfigurationAccess({
    shopId: 'shop-2',
    serviceKey: 'invalid-internal-key',
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});