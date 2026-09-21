import prisma from '../../lib/prisma.js';

export type ApprovalApproverType =
  | 'DIRECT_MANAGER'
  | 'MANAGER_CHAIN'
  | 'ROLE'
  | 'POSITION'
  | 'SPECIFIC_USER';

export type ApprovalPolicySeed = {
  id: string;
  name: string;
  minAmount: number | { toString(): string };
  maxAmount?: number | { toString(): string } | null;
  priority?: number | null;
  expenseTypeId?: string | null;
};

export type ApprovalStepSeed = {
  id: string;
  stepNo: number;
  approverType: ApprovalApproverType;
  approverReference: string;
  isRequired: boolean;
};

type ApprovalUserContext = {
  id?: string;
  userId: string | null;
  managerUserId: string | null;
  role?: string | null;
  position?: string | null;
};

export type ApprovalStepResolution = ApprovalStepSeed & {
  approverUserId: string | null;
  status: 'WAITING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
};

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

export function buildApprovalSteps(
  policy: ApprovalPolicySeed,
  steps: ApprovalStepSeed[],
  actor: ApprovalUserContext,
  approverMap: Map<string, ApprovalUserContext>,
): ApprovalStepResolution[] {
  const orderedSteps = [...steps].sort((left, right) => left.stepNo - right.stepNo);

  return orderedSteps.map((step) => {
    let approverUserId: string | null = null;

    switch (step.approverType) {
      case 'DIRECT_MANAGER': {
        const manager = approverMap.get(actor.managerUserId ?? '');
        approverUserId = manager?.userId ?? null;
        break;
      }
      case 'MANAGER_CHAIN': {
        const level = Number.parseInt(step.approverReference, 10);
        const manager = resolveManagerChain(actor.id ?? actor.userId ?? '', level, approverMap);
        approverUserId = manager?.userId ?? null;
        break;
      }
      case 'ROLE': {
        approverUserId =
          actor.role && actor.role.toUpperCase() === step.approverReference.toUpperCase()
            ? actor.userId
            : Array.from(approverMap.values()).find((candidate) =>
                candidate.role && candidate.role.toUpperCase() === step.approverReference.toUpperCase(),
              )?.userId ?? null;
        break;
      }
      case 'POSITION': {
        approverUserId =
          actor.position && actor.position.toUpperCase() === step.approverReference.toUpperCase()
            ? actor.userId
            : Array.from(approverMap.values()).find((candidate) =>
                candidate.position && candidate.position.toUpperCase() === step.approverReference.toUpperCase(),
              )?.userId ?? null;
        break;
      }
      case 'SPECIFIC_USER': {
        approverUserId = step.approverReference.trim() || null;
        break;
      }
      default:
        approverUserId = null;
    }

    return {
      ...step,
      approverUserId,
      status: 'WAITING',
    };
  });
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

export async function getExpenseApprovalStatus(expenseId: string) {
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

export async function submitExpenseForApproval(expenseId: string, actorUserId?: string) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      expenseType: true,
    },
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

  const policies = await prisma.approvalPolicy.findMany({
    where: { isActive: true },
    include: { steps: { orderBy: { stepNo: 'asc' } } },
    orderBy: { priority: 'desc' },
  });

  const matchingPolicy = policies.find((policy) => {
    const expenseTypeMatches = !policy.expenseTypeId || policy.expenseTypeId === expense.expenseTypeId;
    const amountMatches =
      Number(expense.amount) >= Number(policy.minAmount ?? 0) &&
      (!policy.maxAmount || Number(expense.amount) <= Number(policy.maxAmount));

    return expenseTypeMatches && amountMatches;
  });

  if (!matchingPolicy || matchingPolicy.steps.length === 0) {
    throw new Error('No approval policy matches this expense.');
  }

  const approverMap = new Map<string, ApprovalUserContext>();
  if (expense.sellerUserId) {
    approverMap.set(expense.sellerUserId, {
      id: expense.sellerUserId,
      userId: expense.sellerUserId,
      managerUserId: null,
      role: null,
      position: null,
    });
  }

  const approverSeed = expense.sellerUserId
    ? {
        id: expense.sellerUserId,
        userId: expense.sellerUserId,
        managerUserId: null,
        role: null,
        position: null,
      }
    : null;

  const resolvedSteps = approverSeed
    ? buildApprovalSteps(
        matchingPolicy,
        matchingPolicy.steps.map((step) => ({
          id: step.id,
          stepNo: step.stepNo,
          approverType: step.approverType as ApprovalApproverType,
          approverReference: step.approverReference,
          isRequired: step.isRequired,
        })),
        approverSeed,
        approverMap,
      )
    : matchingPolicy.steps.map((step) => ({
        id: step.id,
        stepNo: step.stepNo,
        approverType: step.approverType as ApprovalApproverType,
        approverReference: step.approverReference,
        isRequired: step.isRequired,
        approverUserId:
          step.approverType === 'SPECIFIC_USER' ? (step.approverReference.trim() || null) : null,
        status: 'WAITING',
      }));

  const createdApprovals = await prisma.$transaction(async (tx) => {
    const approvalRecords = [] as Array<{ id: string; stepNo: number; approverUserId: string | null; status: string }>;

    for (const step of resolvedSteps) {
      const approval = await tx.expenseApproval.create({
        data: {
          expenseId: expense.id,
          stepNo: step.stepNo,
          approverUserId: step.approverUserId ?? null,
          status: step.stepNo === 1 ? 'PENDING' : 'WAITING',
          action: step.stepNo === 1 ? 'SUBMITTED' : null,
        },
      });

      approvalRecords.push({
        id: approval.id,
        stepNo: approval.stepNo,
        approverUserId: approval.approverUserId,
        status: approval.status,
      });

      await tx.expenseApprovalAction.create({
        data: {
          expenseApprovalId: approval.id,
          userId: actorUserId ?? expense.sellerUserId ?? 'system',
          action: 'SUBMITTED',
          comment: `Expense submitted for approval step ${approval.stepNo}`,
        },
      });
    }

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        status: 'PENDING_APPROVAL',
        submittedAt: new Date(),
      },
    });

    return approvalRecords;
  });

  return {
    expenseId: expense.id,
    status: 'PENDING_APPROVAL',
    approvals: createdApprovals,
    policyId: matchingPolicy.id,
  };
}

export async function approveExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string) {
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

    await tx.expenseApprovalAction.create({
      data: {
        expenseApprovalId: approvalId,
        userId: actorUserId,
        action: 'APPROVED',
        comment: comment ?? 'Approved',
      },
    });

    const nextApproval = await tx.expenseApproval.findFirst({
      where: {
        expenseId,
        stepNo: { gt: approval.stepNo },
        status: 'WAITING',
      },
      orderBy: { stepNo: 'asc' },
    });

    if (nextApproval) {
      await tx.expenseApproval.update({
        where: { id: nextApproval.id },
        data: { status: 'PENDING' },
      });
      return {
        expenseId,
        approvalId,
        status: 'APPROVED',
        nextApprovalId: nextApproval.id,
        expenseStatus: 'PENDING_APPROVAL',
        currentApproval: updatedApproval,
      };
    }

    await tx.expense.update({
      where: { id: expenseId },
      data: {
        status: 'APPROVED',
      },
    });

    return {
      expenseId,
      approvalId,
      status: 'APPROVED',
      expenseStatus: 'APPROVED',
      currentApproval: updatedApproval,
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
      data: {
        status: 'REJECTED',
      },
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
