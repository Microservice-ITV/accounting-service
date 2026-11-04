import test from 'node:test';
import assert from 'node:assert/strict';

import prisma from '../../lib/prisma.js';
import {
  advanceApprovalWorkflow,
  approvalPolicyMatchesExpense,
  approveExpenseStep,
  buildSequentialManagerApprovals,
  getMatchingApprovalPolicy,
  rejectExpenseStep,
  resolveManagerChain,
  returnExpenseStep,
  submitExpenseForApproval,
  type ApprovalPolicySeed,
} from './expense-approval.service.js';

test('Policy matching selects the first applicable policy for each amount tier', () => {
  const policies: ApprovalPolicySeed[] = [
    { id: 'p1', name: 'Low', minAmount: 0, maxAmount: 500000, level: 1, priority: 10 },
    { id: 'p2', name: 'Medium', minAmount: 500001, maxAmount: 2000000, level: 2, priority: 20 },
    { id: 'p3', name: 'High', minAmount: 2000001, maxAmount: 100000000, level: 3, priority: 30 },
  ];

  assert.equal(getMatchingApprovalPolicy(500000, policies)?.id, 'p1');
  assert.equal(getMatchingApprovalPolicy(1500000, policies)?.id, 'p2');
  assert.equal(getMatchingApprovalPolicy(5000000, policies)?.id, 'p3');
});

test('Expense approval matrix has non-overlapping amount boundaries', () => {
  const policies: ApprovalPolicySeed[] = [
    { id: 'p1', name: 'Shop Owner', minAmount: 0, maxAmount: 100000, level: 1, priority: 40 },
    { id: 'p2', name: 'Shop Admin', minAmount: 100001, maxAmount: 1000000, level: 2, priority: 30 },
    { id: 'p3', name: 'Operations Manager', minAmount: 1000001, maxAmount: 5000000, level: 3, priority: 20 },
    { id: 'p4', name: 'Director', minAmount: 5000001, maxAmount: null, level: 4, priority: 10 },
  ];

  assert.equal(getMatchingApprovalPolicy(0, policies)?.id, 'p1');
  assert.equal(getMatchingApprovalPolicy(100000, policies)?.id, 'p1');
  assert.equal(getMatchingApprovalPolicy(100001, policies)?.id, 'p2');
  assert.equal(getMatchingApprovalPolicy(1000000, policies)?.id, 'p2');
  assert.equal(getMatchingApprovalPolicy(1000001, policies)?.id, 'p3');
  assert.equal(getMatchingApprovalPolicy(5000000, policies)?.id, 'p3');
  assert.equal(getMatchingApprovalPolicy(5000001, policies)?.id, 'p4');
  assert.equal(getMatchingApprovalPolicy(Number.MAX_SAFE_INTEGER, policies)?.id, 'p4');
});

test('shop expense approval policy must match both shopId and its exact shop condition', () => {
  const expense = { scope: 'SHOP' as const, shopId: 'shop-b', amount: 500 };
  const shopAPolicy: ApprovalPolicySeed = {
    id: 'policy-a',
    name: 'Shop A policy',
    scope: 'SHOP',
    shopId: 'shop-a',
    minAmount: 0,
    maxAmount: 1000,
    conditions: [{ field: 'shopId', operator: '=', value: 'shop-a' }],
  };
  const shopBPolicy: ApprovalPolicySeed = {
    ...shopAPolicy,
    id: 'policy-b',
    name: 'Shop B policy',
    shopId: 'shop-b',
    conditions: [{ field: 'shopId', operator: '=', value: 'shop-b' }],
  };

  assert.equal(approvalPolicyMatchesExpense(expense, shopAPolicy), false);
  assert.equal(approvalPolicyMatchesExpense(expense, shopBPolicy), true);
});

test('platform approval policies retain platform-wide matching behavior', () => {
  assert.equal(approvalPolicyMatchesExpense(
    { scope: 'PLATFORM', shopId: null, amount: 500 },
    { id: 'platform', name: 'Platform policy', scope: 'PLATFORM', shopId: null, minAmount: 0, maxAmount: 1000 },
  ), true);
  assert.equal(approvalPolicyMatchesExpense(
    { scope: 'SHOP', shopId: 'shop-b', amount: 500 },
    { id: 'platform', name: 'Platform policy', scope: 'PLATFORM', shopId: null, minAmount: 0, maxAmount: 1000 },
  ), false);
});

test('Manager hierarchy resolves direct and delegated managers by level', () => {
  const approverMap = new Map<string, { id: string; userId: string; managerUserId: string | null }>([
    ['u1', { id: 'u1', userId: 'u1', managerUserId: 'u2' }],
    ['u2', { id: 'u2', userId: 'u2', managerUserId: 'u3' }],
    ['u3', { id: 'u3', userId: 'u3', managerUserId: null }],
  ]);

  assert.equal(resolveManagerChain('u1', 1, approverMap)?.userId, 'u2');
  assert.equal(resolveManagerChain('u1', 2, approverMap)?.userId, 'u3');
  assert.equal(resolveManagerChain('u1', 3, approverMap), undefined);
});

test('Approval workflow advances sequentially and marks final approval as approved', () => {
  const summary = advanceApprovalWorkflow({
    expenseStatus: 'PENDING_APPROVAL',
    currentStep: { id: 's1', status: 'PENDING' },
    nextStep: { id: 's2', status: 'WAITING' },
    remainingRequiredSteps: 2,
  });

  assert.equal(summary.expenseStatus, 'PENDING_APPROVAL');
  assert.equal(summary.currentStep.status, 'APPROVED');
  assert.ok(summary.nextStep);
  assert.equal(summary.nextStep.status, 'PENDING');
  assert.equal(summary.hasMoreRequiredSteps, true);

  const finalSummary = advanceApprovalWorkflow({
    expenseStatus: 'PENDING_APPROVAL',
    currentStep: { id: 's2', status: 'PENDING' },
    nextStep: null,
    remainingRequiredSteps: 1,
  });

  assert.equal(finalSummary.expenseStatus, 'APPROVED');
  assert.equal(finalSummary.currentStep.status, 'APPROVED');
  assert.equal(finalSummary.hasMoreRequiredSteps, false);
});

test('Rejected step marks the expense as rejected', () => {
  const result = advanceApprovalWorkflow({
    expenseStatus: 'PENDING_APPROVAL',
    currentStep: { id: 's2', status: 'REJECTED' },
    nextStep: null,
    remainingRequiredSteps: 1,
    rejected: true,
  });

  assert.equal(result.expenseStatus, 'REJECTED');
  assert.equal(result.currentStep.status, 'REJECTED');
});

test('policy level is capped by the available manager chain instead of inventing a missing approver', () => {
  const approvals = buildSequentialManagerApprovals(new Map([[1, 'john']]), 2);
  assert.deepEqual(approvals, [{ stepNo: 1, approverUserId: 'john' }]);

  const threeLevelSingleManager = buildSequentialManagerApprovals(new Map([[1, 'john']]), 3);
  assert.deepEqual(threeLevelSingleManager, [{ stepNo: 1, approverUserId: 'john' }]);

  const fullChain = buildSequentialManagerApprovals(new Map([
    [1, 'john'],
    [2, 'sarah'],
  ]), 3);
  assert.deepEqual(fullChain, [
    { stepNo: 1, approverUserId: 'john' },
    { stepNo: 2, approverUserId: 'sarah' },
  ]);
});

test('Shop B expense uses the Shop B policy rather than Shop A policy and creates a journal entry after approval', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const originalFetch = globalThis.fetch;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  try {
    const shopAPolicy = await prisma.approvalPolicy.create({
      data: {
        name: 'Shop A policy must not match Shop B expense',
        shopId: 'shop-a',
        minAmount: 20000,
        maxAmount: 50000,
        level: 1,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'shop-a' }] },
      },
    });
    createdPolicyIds.push(shopAPolicy.id);

    const policy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 2 policy with one manager',
        shopId: 'single-manager-shop',
        minAmount: 20000,
        maxAmount: 50000,
        level: 2,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'single-manager-shop' }] },
      },
    });
    createdPolicyIds.push(policy.id);

    const expense = await prisma.expense.create({
      data: {
        expenseNo: `SINGLE-${Date.now()}`,
        shopId: 'single-manager-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 30000,
        description: 'Single manager approval test',
      },
    });
    createdExpenseIds.push(expense.id);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/shops/single-manager-shop/users')) {
        return new Response(JSON.stringify({
          data: { users: [
            { id: 'seller-membership', shop_id: 'single-manager-shop', user: { id: 'seller-user' }, status: 'active' },
            { id: 'level1-membership', shop_id: 'single-manager-shop', user: { id: 'john' }, status: 'active' },
          ] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        data: {
          shopUserId: 'seller-membership',
          managers: [
            { level: 1, shopUserId: 'level1-membership', userId: 'john', name: 'John' },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const submission = await submitExpenseForApproval(expense.id, 'seller-user', 'token');
    assert.equal(submission.policyId, policy.id);
    assert.deepEqual(submission.approvals.map((approval) => approval.approverUserId), ['john']);
    assert.deepEqual(submission.approvals.map((approval) => approval.status), ['PENDING']);

    const approval = await prisma.expenseApproval.findFirst({ where: { expenseId: expense.id, stepNo: 1 }, select: { id: true } });
    assert.ok(approval, 'expected a pending approval step');

    await approveExpenseStep(expense.id, approval.id, 'john');

    assert.equal(await prisma.expense.count({ where: { id: expense.id, status: 'APPROVED' } }), 1);
    assert.equal(await prisma.journalEntry.count({ where: { referenceType: 'EXPENSE', referenceId: expense.expenseNo } }), 1);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  }
});

test('wrong approver cannot approve another manager step', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const originalFetch = globalThis.fetch;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  try {
    const policy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 2 policy wrong approver',
        shopId: 'wrong-approver-shop',
        minAmount: 20000,
        maxAmount: 50000,
        level: 2,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'wrong-approver-shop' }] },
      },
    });
    createdPolicyIds.push(policy.id);

    const expense = await prisma.expense.create({
      data: {
        expenseNo: `WRONG-${Date.now()}`,
        shopId: 'wrong-approver-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 30000,
        description: 'Wrong approver test',
      },
    });
    createdExpenseIds.push(expense.id);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/shops/wrong-approver-shop/users')) {
        return new Response(JSON.stringify({
          data: { users: 
            [
              { id: 'seller-membership', shop_id: 'wrong-approver-shop', user: { id: 'seller-user' }, status: 'active' },
              { id: 'level1-membership', shop_id: 'wrong-approver-shop', user: { id: 'john' }, status: 'active' },
            ] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        data: {
          shopUserId: 'seller-membership',
          managers: [
            { level: 1, shopUserId: 'level1-membership', userId: 'john', name: 'John' },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await submitExpenseForApproval(expense.id, 'seller-user', 'token');

    const approval = await prisma.expenseApproval.findFirst({ where: { expenseId: expense.id }, select: { id: true } });
    assert.ok(approval, 'expected an approval record');

    await assert.rejects(() => approveExpenseStep(expense.id, approval.id, 'not-john'), /Forbidden: you are not assigned to this approval step/);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  }
});

test('reject and return actions preserve the existing approval behavior', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const originalFetch = globalThis.fetch;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  try {
    const policy = await prisma.approvalPolicy.create({
      data: {
        name: 'Return and reject policy',
        shopId: 'reject-return-shop',
        minAmount: 0,
        maxAmount: 50000,
        level: 1,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'reject-return-shop' }] },
      },
    });
    createdPolicyIds.push(policy.id);

    const rejectExpense = await prisma.expense.create({
      data: {
        expenseNo: `REJECT-${Date.now()}`,
        shopId: 'reject-return-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 15000,
        description: 'Reject test',
      },
    });
    createdExpenseIds.push(rejectExpense.id);

    const returnExpense = await prisma.expense.create({
      data: {
        expenseNo: `RETURN-${Date.now()}`,
        shopId: 'reject-return-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 20000,
        description: 'Return test',
      },
    });
    createdExpenseIds.push(returnExpense.id);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/shops/reject-return-shop/users')) {
        return new Response(JSON.stringify({
          data: { users: [
            { id: 'seller-membership', shop_id: 'reject-return-shop', user: { id: 'seller-user' }, status: 'active' },
            { id: 'level1-membership', shop_id: 'reject-return-shop', user: { id: 'john' }, status: 'active' },
          ] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        data: {
          shopUserId: 'seller-membership',
          managers: [
            { level: 1, shopUserId: 'level1-membership', userId: 'john', name: 'John' },
          ],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const rejectSubmission = await submitExpenseForApproval(rejectExpense.id, 'seller-user', 'token');
    const rejectApproval = await prisma.expenseApproval.findFirst({ where: { expenseId: rejectExpense.id }, select: { id: true } });
    assert.ok(rejectApproval, 'expected a reject approval step');
    await rejectExpenseStep(rejectExpense.id, rejectApproval.id, 'john', 'Rejected by manager');
    assert.equal(await prisma.expense.count({ where: { id: rejectExpense.id, status: 'REJECTED' } }), 1);

    const returnSubmission = await submitExpenseForApproval(returnExpense.id, 'seller-user', 'token');
    const returnApproval = await prisma.expenseApproval.findFirst({ where: { expenseId: returnExpense.id }, select: { id: true } });
    assert.ok(returnApproval, 'expected a return approval step');
    await returnExpenseStep(returnExpense.id, returnApproval.id, 'john', 'Returned for correction');
    assert.equal(await prisma.expense.count({ where: { id: returnExpense.id, status: 'RETURNED' } }), 1);
    assert.deepEqual(rejectSubmission.approvals.map((approval) => approval.status), ['PENDING']);
    assert.deepEqual(returnSubmission.approvals.map((approval) => approval.status), ['PENDING']);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  }
});

test('level 1, 2, and 3 policies snapshot the correct sequential manager chain', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const originalFetch = globalThis.fetch;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  const installAuth = (managers: Array<{ level: number; userId: string }>) => {
    const members = [
      { id: 'seller-membership', shop_id: 'level-shop', user: { id: 'seller-user' }, status: 'active' },
      ...managers.map((manager) => ({
        id: `${manager.userId}-membership`,
        shop_id: 'level-shop',
        user: { id: manager.userId },
        status: 'active',
      })),
    ];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/shops/level-shop/users')) {
        return new Response(JSON.stringify({ data: { users: members } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        data: {
          shopUserId: 'seller-membership',
          managers: managers.map((manager) => ({
            level: manager.level,
            shopUserId: `${manager.userId}-membership`,
            userId: manager.userId,
            name: manager.userId,
          })),
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  };

  try {
    const levelOneExpense = await prisma.expense.create({
      data: {
        expenseNo: `LEVEL1-${Date.now()}`,
        shopId: 'level-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 5000,
        description: 'Level 1 chain test',
      },
    });
    createdExpenseIds.push(levelOneExpense.id);

    const levelOnePolicy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 1 policy',
        shopId: 'level-shop',
        minAmount: 0,
        maxAmount: 10000,
        level: 1,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'level-shop' }] },
      },
    });
    createdPolicyIds.push(levelOnePolicy.id);
    installAuth([{ level: 1, userId: 'john' }]);
    const submission1 = await submitExpenseForApproval(levelOneExpense.id, 'seller-user', 'token');
    assert.deepEqual(submission1.approvals.map((approval) => approval.approverUserId), ['john']);

    const levelTwoExpense = await prisma.expense.create({
      data: {
        expenseNo: `LEVEL2-${Date.now()}`,
        shopId: 'level-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 30000,
        description: 'Level 2 chain test',
      },
    });
    createdExpenseIds.push(levelTwoExpense.id);

    const levelTwoPolicy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 2 policy',
        shopId: 'level-shop',
        minAmount: 20000,
        maxAmount: 50000,
        level: 2,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'level-shop' }] },
      },
    });
    createdPolicyIds.push(levelTwoPolicy.id);
    installAuth([
      { level: 1, userId: 'john' },
      { level: 2, userId: 'backend-lead' },
    ]);
    const submission2 = await submitExpenseForApproval(levelTwoExpense.id, 'seller-user', 'token');
    assert.deepEqual(submission2.approvals.map((approval) => approval.approverUserId), ['john', 'backend-lead']);
    assert.deepEqual(submission2.approvals.map((approval) => approval.status), ['PENDING', 'WAITING']);

    const levelThreeExpense = await prisma.expense.create({
      data: {
        expenseNo: `LEVEL3-${Date.now()}`,
        shopId: 'level-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 75000,
        description: 'Level 3 chain test',
      },
    });
    createdExpenseIds.push(levelThreeExpense.id);

    const levelThreePolicy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 3 policy',
        shopId: 'level-shop',
        minAmount: 60000,
        maxAmount: 100000,
        level: 3,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'level-shop' }] },
      },
    });
    createdPolicyIds.push(levelThreePolicy.id);
    installAuth([
      { level: 1, userId: 'john' },
      { level: 2, userId: 'backend-lead' },
      { level: 3, userId: 'it-manager' },
    ]);
    const submission3 = await submitExpenseForApproval(levelThreeExpense.id, 'seller-user', 'token');
    assert.deepEqual(submission3.approvals.map((approval) => approval.approverUserId), ['john', 'backend-lead', 'it-manager']);
    assert.deepEqual(submission3.approvals.map((approval) => approval.status), ['PENDING', 'WAITING', 'WAITING']);
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  }
});

test('submission fails atomically when no active manager is available', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const originalFetch = globalThis.fetch;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  try {
    const policy = await prisma.approvalPolicy.create({
      data: {
        name: 'Level 3 policy without manager chain',
        shopId: 'missing-hierarchy-shop',
        minAmount: 0,
        maxAmount: 200000,
        level: 3,
        isActive: true,
        conditions: { create: [{ field: 'shopId', operator: '=', value: 'missing-hierarchy-shop' }] },
      },
    });
    createdPolicyIds.push(policy.id);

    const expense = await prisma.expense.create({
      data: {
        expenseNo: `MISSING-${Date.now()}`,
        shopId: 'missing-hierarchy-shop',
        sellerUserId: 'seller-user',
        expenseTypeId: office.id,
        amount: 75000,
        description: 'Missing hierarchy test',
      },
    });
    createdExpenseIds.push(expense.id);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/shops/missing-hierarchy-shop/users')) {
        return new Response(JSON.stringify({
          data: { users: [
            { id: 'seller-membership', shop_id: 'missing-hierarchy-shop', user: { id: 'seller-user' }, status: 'active' },
          ] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        data: {
          shopUserId: 'seller-membership',
          managers: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await assert.rejects(
      () => submitExpenseForApproval(expense.id, 'seller-user', 'token'),
      /No active manager is available for approval/,
    );
    assert.equal(await prisma.expenseApproval.count({ where: { expenseId: expense.id } }), 0);
    assert.equal((await prisma.expense.findUnique({ where: { id: expense.id } }))?.status, 'DRAFT');
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  }
});
