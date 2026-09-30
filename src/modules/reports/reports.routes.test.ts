import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSellerShopScope } from './reports.routes.js';

test('resolveSellerShopScope includes all authorized shops and the active shop', () => {
  const shopIds = resolveSellerShopScope({
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1', 'shop-2', 'shop-2'],
  });

  assert.deepEqual(shopIds, ['shop-1', 'shop-2']);
});

test('resolveSellerShopScope accepts multiple authorized shops without an active shop', () => {
  const shopIds = resolveSellerShopScope({
    activeShopId: null,
    authorizedShopIds: ['shop-1', 'shop-2'],
  });

  assert.deepEqual(shopIds, ['shop-1', 'shop-2']);
});

test('resolveSellerShopScope rejects owners with no authorized or active shop', () => {
  assert.throws(
    () => resolveSellerShopScope({
      activeShopId: null,
      authorizedShopIds: [],
    }),
    /assigned to a shop/i,
  );
});

test('resolveSellerShopScope leaves platform admin reports unfiltered', () => {
  assert.equal(resolveSellerShopScope({ role: 'super_admin', authorizedShopIds: ['shop-1'] }), null);
});

test('resolveSellerShopScope keeps shop admins limited to authorized shops', () => {
  assert.deepEqual(
    resolveSellerShopScope({
      role: 'shop_admin',
      activeShopId: 'shop-1',
      authorizedShopIds: ['shop-1', 'shop-2'],
    }),
    ['shop-1', 'shop-2'],
  );
});
