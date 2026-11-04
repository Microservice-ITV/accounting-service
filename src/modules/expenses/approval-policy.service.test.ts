import test from 'node:test';
import assert from 'node:assert/strict';
import { assertShopOwner, createApprovalPolicy } from './approval-policy.service.js';

test('Shop Owner can manage policies only for a shop where they hold the owner membership', () => {
  const authContext = {
    userId: 'owner-b',
    shops: [
      { shop_id: 'shop-a', role: { code: 'shop_admin' } },
      { shop_id: 'shop-b', role: { code: 'shop_owner' } },
    ],
  };

  assert.equal(assertShopOwner(authContext, 'shop-b'), 'shop-b');
  assert.throws(
    () => assertShopOwner(authContext, 'shop-a'),
    /Only the Shop Owner can manage approval policies for this shop/,
  );
});

test('Shop Admin cannot manage approval policies for their shop', () => {
  assert.throws(
    () => assertShopOwner({
      userId: 'admin-b',
      shops: [{ shop_id: 'shop-b', role: { code: 'shop_admin' } }],
    }, 'shop-b'),
    /Only the Shop Owner can manage approval policies for this shop/,
  );
});

test('policy creation rejects a shop owner attempting to assign a policy to another shop', async () => {
  await assert.rejects(
    () => createApprovalPolicy({
      shopId: 'shop-a',
      name: 'Unauthorized policy',
      minAmount: 0,
      maxAmount: 1000,
    }, {
      userId: 'owner-b',
      shops: [{ shop_id: 'shop-b', role: { code: 'shop_owner' } }],
    }, 'token'),
    /Only the Shop Owner can manage approval policies for this shop/,
  );
});
