import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMatchingApprovalPolicy,
  resolveManagerChain,
  buildApprovalSteps,
  advanceApprovalWorkflow,
  type ApprovalPolicySeed,
  type ApprovalStepSeed,
} from './expense-approval.service.js';

test('Policy matching selects the first applicable policy for each amount tier', () => {
  const policies: ApprovalPolicySeed[] = [
    { id: 'p1', name: 'Low', minAmount: 0, maxAmount: 500000, priority: 10 },
    { id: 'p2', name: 'Medium', minAmount: 500001, maxAmount: 2000000, priority: 20 },
    { id: 'p3', name: 'High', minAmount: 2000001, maxAmount: 100000000, priority: 30 },
  ];

  assert.equal(getMatchingApprovalPolicy(500000, policies)?.id, 'p1');
  assert.equal(getMatchingApprovalPolicy(1500000, policies)?.id, 'p2');
  assert.equal(getMatchingApprovalPolicy(5000000, policies)?.id, 'p3');
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

test('Approval steps are created in the configured sequence', () => {
  const policy: ApprovalPolicySeed = { id: 'p3', name: 'Large Expense', minAmount: 2000001, maxAmount: 100000000, priority: 30 };
  const steps: ApprovalStepSeed[] = [
    { id: 's1', stepNo: 1, approverType: 'MANAGER_CHAIN', approverReference: '1', isRequired: true },
    { id: 's2', stepNo: 2, approverType: 'MANAGER_CHAIN', approverReference: '2', isRequired: true },
    { id: 's3', stepNo: 3, approverType: 'ROLE', approverReference: 'FINANCE_MANAGER', isRequired: true },
  ];

  const approvalSteps = buildApprovalSteps(policy, steps, { id: 'u1', userId: 'u1', managerUserId: 'u2' }, new Map([
    ['u2', { id: 'u2', userId: 'u2', managerUserId: 'u3' }],
    ['u3', { id: 'u3', userId: 'u3', managerUserId: null }],
  ]));

  assert.equal(approvalSteps.length, 3);
  assert.equal(approvalSteps[0].stepNo, 1);
  assert.equal(approvalSteps[1].approverType, 'MANAGER_CHAIN');
  assert.equal(approvalSteps[2].approverReference, 'FINANCE_MANAGER');
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
