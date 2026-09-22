import assert from 'node:assert/strict';
import test from 'node:test';

import prisma from '../../lib/prisma.js';
import {
  createApprovalPolicy,
  type ApprovalPolicyInput,
} from './approval-policy.service.js';
import type { ExpenseAuthContext } from './expense.service.js';

const originalFetch = globalThis.fetch;
const policyIds: string[] = [];

function authContext(shopId: string): ExpenseAuthContext {
  return {
    userId: 'policy-owner',
    authorizedShopIds: [shopId],
    shops: [{ shop_id: shopId, role: { code: 'shop_owner' } }],
  };
}

function installApproverResponse() {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      users: [
        { id: 'policy-owner-membership', shop_id: 'any', user: { id: 'policy-owner' }, status: 'active', role: { code: 'shop_owner' } },
        { id: 'policy-approver-membership', user: { id: 'policy-approver' }, status: 'active', role: { code: 'shop_manager' } },
      ],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

function input(shopId: string, name: string, minAmount: number, maxAmount: number | null, level = 1): ApprovalPolicyInput {
  return {
    shopId,
    name,
    minAmount,
    maxAmount,
    level,
  };
}

async function create(inputValue: ApprovalPolicyInput, shopId = inputValue.shopId) {
  installApproverResponse();
  const policy = await createApprovalPolicy(inputValue, authContext(shopId), 'token');
  policyIds.push(policy.id);
  return policy;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: policyIds } } });
  await prisma.approvalPolicy.deleteMany({ where: { id: { in: policyIds } } });
  await prisma.$disconnect();
});

test('policy overlap allows non-overlapping and boundary ranges', async () => {
  const shopId = `policy-phase6-boundary-${Date.now()}`;
  await create(input(shopId, 'Boundary A', 0, 100));
  await create(input(shopId, 'Boundary B', 101, 200));
  await assert.rejects(
    () => create(input(shopId, 'Overlap', 100, 150)),
    /overlaps active policy/,
  );
});

test('policy overlap allows independent shops', async () => {
  const shopA = `policy-phase6-shop-a-${Date.now()}`;
  const shopB = `policy-phase6-shop-b-${Date.now()}`;
  await create(input(shopA, 'Shop A', 0, 100));
  await create(input(shopB, 'Shop B', 0, 100));
});

test('concurrent overlapping policy creation allows only one active policy', async () => {
  const shopId = `policy-phase6-concurrent-${Date.now()}`;
  const results = await Promise.allSettled([
    create(input(shopId, 'Concurrent A', 500, 600)),
    create(input(shopId, 'Concurrent B', 500, 600)),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const policies = await prisma.approvalPolicy.findMany({
    where: { id: { in: policyIds }, conditions: { some: { field: 'shopId', value: shopId } } },
  });
  assert.equal(policies.length, 1);
});