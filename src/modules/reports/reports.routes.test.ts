import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSellerShopScope } from './reports.routes.js';

test('resolveSellerShopScope prefers the active shop for seller reports', () => {
  const shopId = resolveSellerShopScope({
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1', 'shop-2'],
  });

  assert.equal(shopId, 'shop-1');
});

test('resolveSellerShopScope rejects multi-shop seller access for income reports', () => {
  assert.throws(
    () => resolveSellerShopScope({
      activeShopId: null,
      authorizedShopIds: ['shop-1', 'shop-2'],
    }),
    /single active shop|single shop|multiple shops/i,
  );
});
