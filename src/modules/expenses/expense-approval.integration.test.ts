import assert from 'node:assert/strict';
import test from 'node:test';

import prisma from '../../lib/prisma.js';
import {
  approveExpenseStep,
  getExpenseApprovalStatus,
  getPendingApprovalsForUser,
  rejectExpenseStep,
  returnExpenseStep,
  submitExpenseForApproval,
} from './expense-approval.service.js';

const originalFetch = globalThis.fetch;

function installManagerAuthResponse() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/shops/shop-001/users')) {
      return new Response(JSON.stringify({ data: { users: [
        { id: 'seller-membership', shop_id: 'shop-001', user: { id: 'seller-001' }, status: 'active' },
        { id: 'manager-membership', shop_id: 'shop-001', user: { id: 'shop-admin' }, status: 'active' },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ data: {
      shopUserId: 'seller-membership',
      managers: [{ level: 1, shopUserId: 'manager-membership', userId: 'shop-admin', name: 'Shop Admin' }],
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('approval workflow authorizes pending and action requests by authenticated user UUID', async () => {
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required for the shop-based approval flow');

  const marker = `SHOP-LIVE-${Date.now()}`;
  const createdExpenseIds: string[] = [];
  const createdPolicyIds: string[] = [];

  const createExpense = async (amount: number, suffix: string) => {
    const expense = await prisma.expense.create({
      data: {
        expenseNo: `${marker}-${suffix}`,
        shopId: 'shop-001',
        sellerUserId: 'seller-001',
        expenseTypeId: office.id,
        amount,
        description: `Shop-based approval verification ${suffix}`,
      },
    });
    createdExpenseIds.push(expense.id);
    return expense;
  };

  try {
    const policy = await prisma.approvalPolicy.create({
      data: {
        name: 'Shop-based Office Policy',
        minAmount: 0,
        maxAmount: 10000000,
        level: 1,
        isActive: true,
        conditions: {
          create: [{ field: 'shopId', operator: '=', value: 'shop-001' }],
        },
      },
    });
    createdPolicyIds.push(policy.id);
    installManagerAuthResponse();

    const expense = await createExpense(750000, 'SHOP');
    const submission = await submitExpenseForApproval(expense.id, 'seller-001', 'token');

    assert.equal(submission.approvals.length, 1);
    assert.equal(submission.approvals[0].approverUserId, 'shop-admin');
    assert.equal(submission.approvals[0].status, 'PENDING');

    const assignedApprovals = await getPendingApprovalsForUser('shop-admin');
    assert.equal(assignedApprovals.some((approval) => approval.expenseId === expense.id), true);
    const otherUserApprovals = await getPendingApprovalsForUser('other-user');
    assert.equal(otherUserApprovals.some((approval) => approval.expenseId === expense.id), false);

    await approveExpenseStep(expense.id, submission.approvals[0].id, 'shop-admin');
    const status = await getExpenseApprovalStatus(expense.id);
    assert.equal(status.status, 'APPROVED');
    assert.deepEqual(status.approvals.map((approval) => approval.status), ['APPROVED']);

    const rejectedExpense = await createExpense(800000, 'REJECT');
    const rejectedSubmission = await submitExpenseForApproval(rejectedExpense.id, 'seller-001', 'token');
    await assert.rejects(
      () => approveExpenseStep(rejectedExpense.id, rejectedSubmission.approvals[0].id, 'other-user'),
      /Forbidden/,
    );
    await rejectExpenseStep(rejectedExpense.id, rejectedSubmission.approvals[0].id, 'shop-admin', 'Rejected for testing');
    assert.equal((await getExpenseApprovalStatus(rejectedExpense.id)).status, 'REJECTED');

    const returnedExpense = await createExpense(850000, 'RETURN');
    const returnedSubmission = await submitExpenseForApproval(returnedExpense.id, 'seller-001', 'token');
    await returnExpenseStep(returnedExpense.id, returnedSubmission.approvals[0].id, 'shop-admin', 'Returned for testing');
    assert.equal((await getExpenseApprovalStatus(returnedExpense.id)).status, 'RETURNED');
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.expenseApprovalAction.deleteMany({ where: { userId: 'shop-admin' } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
    await prisma.$disconnect();
  }
});
