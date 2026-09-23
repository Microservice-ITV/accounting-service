import assert from 'node:assert/strict';
import test from 'node:test';

import prisma from '../../lib/prisma.js';
import {
  approveExpenseStep,
  getExpenseApprovalStatus,
  submitExpenseForApproval,
} from './expense-approval.service.js';

let shopId = 'manager-chain-test-shop';
const sellerUserId = 'manager-chain-seller';
const originalFetch = globalThis.fetch;
const createdExpenseIds: string[] = [];
const createdPolicyIds: string[] = [];

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installAuthResponses(managerCount: number) {
  const members = [
    { id: 'seller-membership', shop_id: shopId, user: { id: sellerUserId }, status: 'active' },
    ...Array.from({ length: managerCount }, (_, index) => ({
      id: `manager-membership-${index + 1}`,
      shop_id: shopId,
      user: { id: `manager-user-${index + 1}` },
      status: 'active',
    })),
  ];
  const managers = Array.from({ length: managerCount }, (_, index) => ({
    level: index + 1,
    shopUserId: `manager-membership-${index + 1}`,
    userId: `manager-user-${index + 1}`,
    name: `Manager ${index + 1}`,
  }));
  const responses = [
    response({ data: { users: members } }),
    response({ data: { shopUserId: 'seller-membership', managers } }),
  ];

  globalThis.fetch = (async () => responses.shift() ?? response({})) as typeof fetch;
}

function useShop(suffix: string) {
  shopId = `manager-chain-${suffix}-${Date.now()}`;
}

async function officeCategoryId() {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');
  return office.id;
}

async function createPolicy(stepCount: number, name: string) {
  const policy = await prisma.approvalPolicy.create({
    data: {
      name,
      minAmount: 0,
      maxAmount: 10000000,
      level: stepCount,
      isActive: true,
      conditions: {
        create: [{ field: 'shopId', operator: '=', value: shopId }],
      },
    },
  });
  createdPolicyIds.push(policy.id);
  return policy;
}

async function createExpense(suffix: string) {
  const expense = await prisma.expense.create({
    data: {
      expenseNo: `MANAGER-CHAIN-${Date.now()}-${suffix}`,
      shopId,
      sellerUserId,
      expenseTypeId: await officeCategoryId(),
      amount: 1000,
      description: `Manager chain test ${suffix}`,
    },
  });
  createdExpenseIds.push(expense.id);
  return expense;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(async () => {
  await prisma.expenseApprovalAction.deleteMany({ where: { expenseApproval: { expenseId: { in: createdExpenseIds } } } });
  await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
  const createdExpenses = await prisma.expense.findMany({ where: { id: { in: createdExpenseIds } }, select: { expenseNo: true } });
  const expenseReferences = createdExpenses.map((createdExpense) => createdExpense.expenseNo);
  await prisma.entryLine.deleteMany({ where: { journalEntry: { referenceType: 'EXPENSE', referenceId: { in: expenseReferences } } } });
  await prisma.journalEntry.deleteMany({ where: { referenceType: 'EXPENSE', referenceId: { in: expenseReferences } } });
  await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
  await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
  await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
  await prisma.$disconnect();
});

test('one-level MANAGER_CHAIN snapshots the direct manager user ID', async () => {
  useShop('one');
  await createPolicy(1, `Manager chain one ${Date.now()}`);
  const expense = await createExpense('one');
  installAuthResponses(1);

  const submission = await submitExpenseForApproval(expense.id, sellerUserId, 'token');

  assert.deepEqual(submission.approvals.map((approval) => approval.approverUserId), ['manager-user-1']);
});

test('multi-level MANAGER_CHAIN maps each level to its approval step and stays sequential', async () => {
  useShop('three');
  await createPolicy(3, `Manager chain three ${Date.now()}`);
  const expense = await createExpense('three');
  installAuthResponses(3);

  const submission = await submitExpenseForApproval(expense.id, sellerUserId, 'token');
  assert.deepEqual(submission.approvals.map((approval) => approval.approverUserId), [
    'manager-user-1',
    'manager-user-2',
    'manager-user-3',
  ]);
  assert.deepEqual(submission.approvals.map((approval) => approval.status), ['PENDING', 'WAITING', 'WAITING']);

  await approveExpenseStep(expense.id, submission.approvals[0].id, 'manager-user-1');
  assert.equal(await prisma.journalEntry.count({ where: { referenceType: 'EXPENSE', referenceId: expense.expenseNo } }), 0);
  assert.deepEqual((await getExpenseApprovalStatus(expense.id)).approvals.map((approval) => approval.status), [
    'APPROVED',
    'PENDING',
    'WAITING',
  ]);

  installAuthResponses(1);
  const snapshot = await getExpenseApprovalStatus(expense.id);
  assert.deepEqual(snapshot.approvals.map((approval) => approval.approverUserId), [
    'manager-user-1',
    'manager-user-2',
    'manager-user-3',
  ]);
  await approveExpenseStep(expense.id, submission.approvals[1].id, 'manager-user-2');
  await approveExpenseStep(expense.id, submission.approvals[2].id, 'manager-user-3');
  assert.equal((await getExpenseApprovalStatus(expense.id)).status, 'APPROVED');
  assert.equal(await prisma.journalEntry.count({ where: { referenceType: 'EXPENSE', referenceId: expense.expenseNo } }), 1);
});

test('submission fails atomically when the required manager level is missing', async () => {
  useShop('insufficient');
  await createPolicy(2, `Manager chain insufficient ${Date.now()}`);
  const expense = await createExpense('insufficient');
  installAuthResponses(1);

  await assert.rejects(
    () => submitExpenseForApproval(expense.id, sellerUserId, 'token'),
    /Required manager level 2 is unavailable/,
  );

  const persisted = await prisma.expense.findUnique({ where: { id: expense.id } });
  assert.equal(persisted?.status, 'DRAFT');
  assert.equal(await prisma.expenseApproval.count({ where: { expenseId: expense.id } }), 0);
});

test('submission fails when the seller has no manager', async () => {
  useShop('none');
  await createPolicy(1, `Manager chain none ${Date.now()}`);
  const expense = await createExpense('none');
  installAuthResponses(0);

  await assert.rejects(
    () => submitExpenseForApproval(expense.id, sellerUserId, 'token'),
    /Required manager level 1 is unavailable/,
  );

  const persisted = await prisma.expense.findUnique({ where: { id: expense.id } });
  assert.equal(persisted?.status, 'DRAFT');
  assert.equal(await prisma.expenseApproval.count({ where: { expenseId: expense.id } }), 0);
});
