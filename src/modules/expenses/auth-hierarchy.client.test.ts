import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveManagerChainFromAuth } from './auth-hierarchy.client.js';

const originalFetch = globalThis.fetch;

function response(payload: unknown, ok = true): Response {
  return new Response(JSON.stringify(payload), {
    status: ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(responses: Response[]) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return responses.shift() ?? response({}, false);
  }) as typeof fetch;
  return urls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AUTH_SERVICE_BASE_URL;
});

test('resolves seller membership before fetching nearest-first manager levels', async () => {
  process.env.AUTH_SERVICE_BASE_URL = 'http://authservice-nginx/api/v1';
  const urls = installFetch([
    response({ data: { users: [
      { id: 'shop-user-seller', shop_id: 'shop-a', user: { id: 'seller-user' }, status: 'active' },
      { id: 'shop-user-manager', shop_id: 'shop-a', user: { id: 'manager-user' }, status: 'active' },
      { id: 'shop-user-senior', shop_id: 'shop-a', user: { id: 'senior-user' }, status: 'active' },
    ] } }),
    response({ data: {
      shopUserId: 'shop-user-seller',
      managers: [
        { level: 1, shopUserId: 'shop-user-manager', userId: 'manager-user', name: 'Manager' },
        { level: 2, shopUserId: 'shop-user-senior', userId: 'senior-user', name: 'Senior' },
      ],
    } }),
  ]);

  const result = await resolveManagerChainFromAuth('shop-a', 'seller-user', 'token');

  assert.deepEqual([...result.entries()], [[1, 'manager-user'], [2, 'senior-user']]);
  assert.deepEqual(urls, [
    'http://authservice-nginx/api/v1/shops/shop-a/users',
    'http://authservice-nginx/api/v1/shops/shop-a/users/shop-user-seller/manager-chain',
  ]);
});

test('rejects a manager-chain response that is not represented by an active same-shop membership', async () => {
  installFetch([
    response({ data: { users: [
      { id: 'seller-membership', shop_id: 'shop-a', user: { id: 'seller-user' }, status: 'active' },
    ] } }),
    response({ data: {
      shopUserId: 'seller-membership',
      managers: [{ level: 1, shopUserId: 'other-shop-membership', userId: 'other-user', name: 'Other' }],
    } }),
  ]);

  await assert.rejects(
    () => resolveManagerChainFromAuth('shop-a', 'seller-user', 'token'),
    /Invalid manager-chain response/,
  );
});

test('rejects missing seller membership and inactive manager memberships', async () => {
  installFetch([response({ data: { users: [] } })]);
  await assert.rejects(
    () => resolveManagerChainFromAuth('shop-a', 'seller-user', 'token'),
    /Seller shop membership was not found/,
  );

  installFetch([
    response({ data: { users: [
      { id: 'seller-membership', shop_id: 'shop-a', user: { id: 'seller-user' }, status: 'active' },
      { id: 'manager-membership', shop_id: 'shop-a', user: { id: 'manager-user' }, status: 'inactive' },
    ] } }),
    response({ data: {
      shopUserId: 'seller-membership',
      managers: [{ level: 1, shopUserId: 'manager-membership', userId: 'manager-user', name: 'Manager' }],
    } }),
  ]);

  await assert.rejects(
    () => resolveManagerChainFromAuth('shop-a', 'seller-user', 'token'),
    /Invalid manager-chain response/,
  );
});

test('selects the seller membership for the requested shop when the user belongs to multiple shops', async () => {
  const urls = installFetch([
    response({ data: { users: [
      { id: 'seller-shop-a', shop_id: 'shop-a', user: { id: 'same-user' }, status: 'active' },
      { id: 'seller-shop-b', shop_id: 'shop-b', user: { id: 'same-user' }, status: 'active' },
      { id: 'manager-shop-b', shop_id: 'shop-b', user: { id: 'manager-b' }, status: 'active' },
    ] } }),
    response({ data: {
      shopUserId: 'seller-shop-a',
      managers: [{ level: 1, shopUserId: 'seller-shop-a-manager', userId: 'manager-a', name: 'Manager A' }],
    } }),
  ]);

  await assert.rejects(
    () => resolveManagerChainFromAuth('shop-a', 'same-user', 'token'),
    /Invalid manager-chain response/,
  );
  assert.equal(urls[1], 'http://localhost:8000/api/v1/shops/shop-a/users/seller-shop-a/manager-chain');
});
