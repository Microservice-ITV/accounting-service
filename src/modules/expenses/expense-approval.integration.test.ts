import assert from 'node:assert/strict';
import test from 'node:test';

import prisma from '../../lib/prisma.js';
import {
  approveExpenseStep,
  getExpenseApprovalStatus,
  rejectExpenseStep,
  submitExpenseForApproval,
} from './expense-approval.service.js';

test.skip('approval workflow passes for a shop-owned expense against the live PostgreSQL database', async () => {
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
        priority: 10,
        isActive: true,
        steps: {
          create: [
            {
              stepNo: 1,
              approverType: 'SPECIFIC_USER',
              approverReference: 'shop-admin',
              isRequired: true,
            },
          ],
        },
      },
      include: { steps: true },
    });
    createdPolicyIds.push(policy.id);

    const expense = await createExpense(750000, 'SHOP');
    const submission = await submitExpenseForApproval(expense.id, 'seller-001');

    assert.equal(submission.approvals.length, 1);
    assert.equal(submission.approvals[0].approverUserId, 'shop-admin');
    assert.equal(submission.approvals[0].status, 'PENDING');

    await approveExpenseStep(expense.id, submission.approvals[0].id, 'shop-admin');
    const status = await getExpenseApprovalStatus(expense.id);
    assert.equal(status.status, 'APPROVED');
    assert.deepEqual(status.approvals.map((approval) => approval.status), ['APPROVED']);
  } finally {
    await prisma.expenseApprovalAction.deleteMany({ where: { userId: 'shop-admin' } });
    await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: createdExpenseIds } } });
    await prisma.approvalPolicyStep.deleteMany({ where: { approvalPolicyId: { in: createdPolicyIds } } });
    await prisma.approvalPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
    await prisma.$disconnect();
  }
});
