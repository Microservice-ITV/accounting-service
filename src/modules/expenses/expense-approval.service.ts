import prisma from '../../lib/prisma.js';
import { createJournalEntryInTransaction } from '../entries/entry.service.js';
import { resolveManagerChainFromAuth } from './auth-hierarchy.client.js';

export type ApprovalPolicySeed = {
  id: string;
  name: string;
  minAmount: number | { toString(): string };
  maxAmount?: number | { toString(): string } | null;
  level?: number | null;
  priority?: number | null;
  expenseTypeId?: string | null;
  conditions?: Array<{ field: string; operator: string; value: string }>;
};

export type ApprovalUserContext = {
  id?: string | null;
  userId: string | null;
  managerUserId: string | null;
  role?: string | null;
  position?: string | null;
};

export type ManagerChainApprovers = Map<number, string>;

type AuthShopUser = {
  id?: string | null;
  user?: { id?: string | null } | null;
  user_id?: string | null;
  shop_id?: string | null;
  reporting_to?: string | null;
  status?: string | null;
  role?: { code?: string | null } | null;
  position?: string | null;
  manager_user_id?: string | null;
};

async function loadShopApproverMap(shopId: string | null, bearerToken?: string) {
  const approverMap = new Map<string, ApprovalUserContext>();
  if (!shopId || !bearerToken) {
    return approverMap;
  }

  const authBaseUrl = (process.env.AUTH_SERVICE_BASE_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
  const response = await fetch(`${authBaseUrl}/shops/${encodeURIComponent(shopId)}/users`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return approverMap;
  }

  const payload = await response.json().catch(() => null) as { data?: { users?: AuthShopUser[] } } | null;
  const members = (payload?.data?.users ?? []).filter(
    (member) => (!member.shop_id || member.shop_id === shopId) && member.status === 'active',
  );
  const memberByShopUserId = new Map(
    members
      .filter((member): member is AuthShopUser & { id: string } => typeof member.id === 'string' && member.id.length > 0)
      .map((member) => [member.id, member] as const),
  );

  for (const member of members) {
    const userId = member.user?.id ?? member.user_id ?? null;
    if (!userId) {
      continue;
    }

    const manager = member.reporting_to ? memberByShopUserId.get(member.reporting_to) : undefined;
    const managerUserId =
      manager
      && manager.id !== member.id
      && manager.status === 'active'
      && (manager.shop_id === null || manager.shop_id === undefined || manager.shop_id === shopId)
      && (manager.user?.id ?? manager.user_id) !== userId
      ? manager.user?.id ?? manager.user_id ?? null
      : null;

    approverMap.set(userId, {
      id: userId,
      userId,
      managerUserId,
      role: member.role?.code ?? null,
      position: member.position ?? null,
    });
  }

  return approverMap;
}

export function getMatchingApprovalPolicy(amount: number, policies: ApprovalPolicySeed[]) {
  const validPolicies = [...policies].sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0));

  return validPolicies.find((policy) => {
    const minAmount = Number(policy.minAmount ?? 0);
    const maxAmount = policy.maxAmount == null ? Number.POSITIVE_INFINITY : Number(policy.maxAmount);
    return amount >= minAmount && amount <= maxAmount;
  });
}

export function resolveManagerChain(
  userId: string,
  level: number,
  approverMap: Map<string, ApprovalUserContext>,
): ApprovalUserContext | undefined {
  if (!Number.isInteger(level) || level < 1) {
    return undefined;
  }

  let currentId: string | null = userId;
  let currentLevel = 0;

  while (currentId && currentLevel < level) {
    const candidate = approverMap.get(currentId);
    if (!candidate) {
      return undefined;
    }

    if (currentLevel === level - 1) {
      return approverMap.get(candidate.managerUserId ?? '');
    }

    const nextManagerId = candidate.managerUserId;
    if (!nextManagerId) {
      return undefined;
    }

    currentId = nextManagerId;
    currentLevel += 1;
  }

  return undefined;
}

function buildSequentialManagerApprovals(managerChain: Map<number, string>, requiredLevel: number) {
  const approvals: Array<{ stepNo: number; approverUserId: string }> = [];

  for (let level = 1; level <= requiredLevel; level += 1) {
    const approverUserId = managerChain.get(level);
    if (!approverUserId) {
      throw new Error(`Required manager level ${level} is unavailable`);
    }

    approvals.push({ stepNo: level, approverUserId });
  }

  return approvals;
}

export function advanceApprovalWorkflow({
  expenseStatus,
  currentStep,
  nextStep,
  remainingRequiredSteps,
  rejected = false,
}: {
  expenseStatus: string;
  currentStep: { id: string; status: string };
  nextStep: { id: string; status: string } | null;
  remainingRequiredSteps: number;
  rejected?: boolean;
}) {
  const updatedCurrentStep = { ...currentStep, status: rejected ? 'REJECTED' : 'APPROVED' };

  if (rejected) {
    return {
      expenseStatus: 'REJECTED',
      currentStep: updatedCurrentStep,
      nextStep,
      hasMoreRequiredSteps: false,
    };
  }

  const hasMoreRequiredSteps = remainingRequiredSteps > 1;
  const updatedNextStep = nextStep
    ? {
        ...nextStep,
        status: hasMoreRequiredSteps ? 'PENDING' : 'WAITING',
      }
    : null;

  return {
    expenseStatus: updatedNextStep ? expenseStatus : 'APPROVED',
    currentStep: updatedCurrentStep,
    nextStep: updatedNextStep,
    hasMoreRequiredSteps,
  };
}

export async function getExpenseApprovalStatus(expenseId: string, authorizedShopIds?: readonly string[]) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      approvals: {
        orderBy: { stepNo: 'asc' },
      },
    },
  });

  if (!expense) {
    throw new Error('Expense not found');
  }

  if (authorizedShopIds && (!expense.shopId || !authorizedShopIds.includes(expense.shopId))) {
    throw new Error('Forbidden: you do not have access to this expense shop');
  }

  return {
    expenseId: expense.id,
    status: expense.status,
    approvals: expense.approvals,
  };
}

export async function getPendingApprovalsForUser(userId: string) {
  return prisma.expenseApproval.findMany({
    where: {
      approverUserId: userId,
      status: 'PENDING',
    },
    include: {
      expense: true,
    },
    orderBy: [{ createdAt: 'asc' }],
  });
}

export async function submitExpenseForApproval(expenseId: string, actorUserId?: string, bearerToken?: string) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: { expenseType: true },
  });

  if (!expense) {
    throw new Error('Expense not found');
  }

  if (actorUserId && expense.sellerUserId && actorUserId !== expense.sellerUserId) {
    throw new Error('Only the expense owner can submit this expense');
  }

  if (expense.status === 'PENDING_APPROVAL' || expense.status === 'APPROVED' || expense.status === 'REJECTED') {
    throw new Error(`Expense cannot be submitted from status ${expense.status}`);
  }

  const activePolicies = await prisma.approvalPolicy.findMany({
    where: { isActive: true },
    include: { conditions: true },
    orderBy: [{ level: 'asc' }, { minAmount: 'asc' }],
  });

  const matchingPolicy = activePolicies.find((policy) => {
    const shopMatches = policy.conditions.some(
      (condition) => condition.field === 'shopId' && condition.operator === '=' && condition.value === expense.shopId,
    );
    const amountMatches =
      Number(expense.amount) >= Number(policy.minAmount ?? 0) &&
      (policy.maxAmount == null || Number(expense.amount) <= Number(policy.maxAmount));

    return shopMatches && amountMatches;
  });

  if (!matchingPolicy) {
    throw new Error('No approval policy matches this expense.');
  }

  if (!expense.sellerUserId || !expense.shopId) {
    throw new Error('Expense is missing seller or shop information');
  }

  const managerChain = await resolveManagerChainFromAuth(expense.shopId, expense.sellerUserId, bearerToken);
  const approvalChain = buildSequentialManagerApprovals(managerChain, matchingPolicy.level ?? 1);

  const submission = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;
    const transactionExpense = await tx.expense.findUnique({ where: { id: expenseId } });

    if (!transactionExpense) {
      throw new Error('Expense not found');
    }

    if (transactionExpense.status === 'PENDING_APPROVAL' || transactionExpense.status === 'APPROVED') {
      const existingApprovals = await tx.expenseApproval.findMany({
        where: { expenseId },
        orderBy: { stepNo: 'asc' },
      });
      return { status: transactionExpense.status, approvals: existingApprovals };
    }

    if (transactionExpense.status === 'REJECTED') {
      throw new Error(`Expense cannot be submitted from status ${transactionExpense.status}`);
    }

    const hasReturnedApproval = transactionExpense.status === 'RETURNED'
      || Boolean(await tx.expenseApproval.findFirst({
        where: { expenseId, action: 'RETURNED' },
        select: { id: true },
      }));

    if (hasReturnedApproval) {
      await tx.expenseApproval.deleteMany({ where: { expenseId } });
    }

    const approvalRecords: Array<{ id: string; stepNo: number; approverUserId: string | null; status: string }> = [];

    for (const approvalStep of approvalChain) {
      const status = approvalStep.stepNo === 1 ? 'PENDING' : 'WAITING';
      const approval = await tx.expenseApproval.create({
        data: {
          expenseId: transactionExpense.id,
          stepNo: approvalStep.stepNo,
          approverUserId: approvalStep.approverUserId,
          status,
          action: approvalStep.stepNo === 1 ? 'SUBMITTED' : null,
        },
      });

      approvalRecords.push({
        id: approval.id,
        stepNo: approval.stepNo,
        approverUserId: approval.approverUserId,
        status: approval.status,
      });

      if (approvalStep.stepNo === 1) {
        await tx.expenseApprovalAction.create({
          data: {
            expenseApprovalId: approval.id,
            userId: actorUserId ?? expense.sellerUserId ?? 'system',
            action: 'SUBMITTED',
            comment: `Expense submitted for approval at manager level ${approvalStep.stepNo}`,
          },
        });
      }
    }

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        status: 'PENDING_APPROVAL',
        submittedAt: new Date(),
      },
    });

    return {
      status: 'PENDING_APPROVAL',
      approvals: approvalRecords,
    };
  });

  return {
    expenseId: expense.id,
    status: submission.status,
    approvals: submission.approvals,
    policyId: matchingPolicy.id,
  };
}

export async function approveExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ExpenseApproval" WHERE id = ${approvalId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;

    const approval = await tx.expenseApproval.findUnique({
      where: { id: approvalId },
      include: { expense: { include: { expenseType: true } } },
    });

    if (!approval || approval.expenseId !== expenseId) {
      throw new Error('Approval not found for this expense');
    }

    if (approval.approverUserId !== actorUserId) {
      throw new Error('Forbidden: you are not assigned to this approval step');
    }

    if (approval.status !== 'PENDING') {
      throw new Error(`Approval step must be pending. Current status: ${approval.status}`);
    }

    if (approval.expense.status !== 'PENDING_APPROVAL') {
      throw new Error('Expense is no longer awaiting approval');
    }

    const updatedApproval = await tx.expenseApproval.update({
      where: { id: approvalId },
      data: {
        status: 'APPROVED',
        action: 'APPROVED',
        approvedAt: new Date(),
        comment: comment ?? null,
      },
    });

    const nextApproval = await tx.expenseApproval.findFirst({
      where: {
        expenseId,
        stepNo: { gt: approval.stepNo },
      },
      orderBy: { stepNo: 'asc' },
    });

    if (nextApproval) {
      await tx.expenseApproval.update({
        where: { id: nextApproval.id },
        data: {
          status: 'PENDING',
          action: 'SUBMITTED',
        },
      });
    }

    await tx.expenseApprovalAction.create({
      data: {
        expenseApprovalId: approvalId,
        userId: actorUserId,
        action: 'APPROVED',
        comment: comment ?? 'Approved',
      },
    });

    await tx.expense.update({
      where: { id: expenseId },
      data: { status: nextApproval ? 'PENDING_APPROVAL' : 'APPROVED' },
    });

    if (!nextApproval) {
      const existingJournal = await tx.journalEntry.findUnique({
        where: {
          referenceType_referenceId: {
            referenceType: 'EXPENSE',
            referenceId: approval.expense.expenseNo,
          },
        },
        select: { id: true },
      });

      if (!existingJournal) {
        await createJournalEntryInTransaction({
          referenceType: 'EXPENSE',
          referenceId: approval.expense.expenseNo,
          narration: [approval.expense.expenseType.name, approval.expense.description]
            .filter(Boolean)
            .join(' - ') || 'Expense recorded',
          entryDate: approval.expense.expenseDate,
          lines: [
            {
              accountCode: approval.expense.expenseAccountCode,
              direction: 'DEBIT',
              amount: Number(approval.expense.amount),
              memo: approval.expense.expenseType.name,
            },
            {
              accountCode: approval.expense.fundingAccountCode,
              direction: 'CREDIT',
              amount: Number(approval.expense.amount),
              memo: `${approval.expense.expenseType.name} paid`,
            },
          ],
        }, tx);
      }
    }

    return {
      expenseId,
      approvalId,
      status: 'APPROVED',
      expenseStatus: nextApproval ? 'PENDING_APPROVAL' : 'APPROVED',
      currentApproval: updatedApproval,
      nextApproval: nextApproval ? { ...nextApproval, status: 'PENDING' } : null,
    };
  });
}

export async function rejectExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ExpenseApproval" WHERE id = ${approvalId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;

    const approval = await tx.expenseApproval.findUnique({
      where: { id: approvalId },
      include: { expense: true },
    });

    if (!approval || approval.expenseId !== expenseId) {
      throw new Error('Approval not found for this expense');
    }

    if (approval.approverUserId !== actorUserId) {
      throw new Error('Forbidden: you are not assigned to this approval step');
    }

    if (approval.status !== 'PENDING') {
      throw new Error(`Approval step must be pending. Current status: ${approval.status}`);
    }

    const updatedApproval = await tx.expenseApproval.update({
      where: { id: approvalId },
      data: {
        status: 'REJECTED',
        action: 'REJECTED',
        rejectedAt: new Date(),
        comment: comment ?? null,
      },
    });

    await tx.expenseApprovalAction.create({
      data: {
        expenseApprovalId: approvalId,
        userId: actorUserId,
        action: 'REJECTED',
        comment: comment ?? 'Rejected',
      },
    });

    await tx.expense.update({
      where: { id: expenseId },
      data: { status: 'REJECTED' },
    });

    return {
      expenseId,
      approvalId,
      status: 'REJECTED',
      expenseStatus: 'REJECTED',
      currentApproval: updatedApproval,
    };
  });
}

export async function returnExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ExpenseApproval" WHERE id = ${approvalId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;

    const approval = await tx.expenseApproval.findUnique({
      where: { id: approvalId },
      include: { expense: true },
    });

    if (!approval || approval.expenseId !== expenseId) {
      throw new Error('Approval not found for this expense');
    }

    if (approval.approverUserId !== actorUserId) {
      throw new Error('Forbidden: you are not assigned to this approval step');
    }

    if (approval.status !== 'PENDING') {
      throw new Error(`Approval step must be pending. Current status: ${approval.status}`);
    }

    const updatedApproval = await tx.expenseApproval.update({
      where: { id: approvalId },
      data: {
        status: 'REJECTED',
        action: 'RETURNED',
        comment: comment ?? null,
      },
    });

    await tx.expenseApprovalAction.create({
      data: {
        expenseApprovalId: approvalId,
        userId: actorUserId,
        action: 'RETURNED',
        comment: comment ?? 'Returned for correction',
      },
    });

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        status: 'RETURNED',
      },
    });

    return {
      expenseId,
      approvalId,
      status: 'RETURNED',
      expenseStatus: 'RETURNED',
      currentApproval: updatedApproval,
    };
  });
}
