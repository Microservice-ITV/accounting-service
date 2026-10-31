import prisma from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import type { ExpenseAuthContext } from './expense.service.js';

const SHOP_SCOPE_FIELD = 'shopId';
const AMOUNT_FIELD = 'amount';

export type ApprovalPolicyInput = {
  scope?: 'SHOP' | 'PLATFORM';
  shopId: string;
  approverUserId?: string | null;
  name: string;
  minAmount: number;
  maxAmount?: number | null;
  level?: number;
  isActive?: boolean;
};

type AuthShopUser = {
  shop_id?: string | null;
  status?: string | null;
  user?: { id?: string | null; name?: string | null; email?: string | null } | null;
  user_id?: string | null;
  role?: { code?: string | null; name?: string | null } | null;
  position?: string | null;
};

type ApproverOption = {
  id: string;
  name: string;
  email: string | null;
  roleCode: string | null;
  roleName: string | null;
  position: string | null;
};

const policyInclude = {
  conditions: { orderBy: { createdAt: 'asc' as const } },
};

const platformPolicyRoles = new Set(['platform_super_admin', 'super_admin']);

function assertPlatformPolicyAdmin(authContext: ExpenseAuthContext | null | undefined) {
  if (!authContext?.userId) throw new Error('Unauthenticated');
  if (!platformPolicyRoles.has(authContext.role?.trim().toLowerCase() ?? '')) {
    throw new Error('Only a platform administrator can manage platform approval policies');
  }
}

type PolicyDbClient = Prisma.TransactionClient | typeof prisma;

function getShopAccess(authContext: ExpenseAuthContext, shopId: string) {
  const normalizedShopId = shopId.trim();
  const shop = authContext.shops?.find((item) => item.shop_id === normalizedShopId);
  return { normalizedShopId, shop };
}

export function assertShopOwner(authContext: ExpenseAuthContext | null | undefined, shopId: string) {
  if (!authContext?.userId) {
    throw new Error('Unauthenticated');
  }

  const { normalizedShopId, shop } = getShopAccess(authContext, shopId);
  const roleCode = shop?.role?.code?.toLowerCase();
  if (!shop || roleCode !== 'shop_owner') {
    throw new Error('Only the Shop Owner can manage approval policies for this shop');
  }

  return normalizedShopId;
}

function validateAmountRange(minAmount: number, maxAmount?: number | null) {
  if (!Number.isFinite(minAmount) || minAmount < 0) {
    throw new Error('Minimum amount must be a non-negative number');
  }
  if (maxAmount !== null && maxAmount !== undefined && (!Number.isFinite(maxAmount) || maxAmount < minAmount)) {
    throw new Error('Maximum amount must be greater than or equal to minimum amount');
  }
}

function validateLevel(level: number) {
  if (!Number.isInteger(level) || level < 1) {
    throw new Error('Approval level must be a positive integer');
  }
}

async function loadShopMembers(shopId: string, bearerToken: string) {
  const authBaseUrl = (process.env.AUTH_SERVICE_BASE_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
  const response = await fetch(`${authBaseUrl}/shops/${encodeURIComponent(shopId)}/users`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Unable to load approvers for this shop');
  }

  const payload = await response.json().catch(() => null) as { data?: { users?: AuthShopUser[] } } | null;
  return (payload?.data?.users ?? []).filter(
    (member) => (!member.shop_id || member.shop_id === shopId) && member.status === 'active',
  );
}

function getRange(policy: { minAmount: unknown; maxAmount: unknown }) {
  return {
    min: Number(policy.minAmount ?? 0),
    max: policy.maxAmount == null ? Number.POSITIVE_INFINITY : Number(policy.maxAmount),
  };
}

function rangesOverlap(left: { minAmount: unknown; maxAmount: unknown }, right: { minAmount: unknown; maxAmount: unknown }) {
  const leftRange = getRange(left);
  const rightRange = getRange(right);
  return leftRange.min <= rightRange.max && rightRange.min <= leftRange.max;
}

function expenseTypesOverlap(left: string | null, right: string | null) {
  return left === null || right === null || left === right;
}

async function lockPolicyShop(client: PolicyDbClient, shopId: string) {
  await client.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('accounting.approval-policy'),
      hashtext(${shopId})
    )
  `;
}

async function assertNoActiveOverlap(input: ApprovalPolicyInput, excludePolicyId?: string, client: PolicyDbClient = prisma) {
  const existingPolicies = await client.approvalPolicy.findMany({
    where: {
      isActive: true,
      scope: input.scope ?? 'SHOP',
      ...(input.scope === 'PLATFORM'
        ? { shopId: null }
        : {
          shopId: input.shopId,
          conditions: { some: { field: SHOP_SCOPE_FIELD, operator: '=', value: input.shopId ?? '' } },
        }),
      ...(excludePolicyId ? { id: { not: excludePolicyId } } : {}),
    },
    select: { id: true, name: true, minAmount: true, maxAmount: true },
  });

  const conflictingPolicy = existingPolicies.find((policy) =>
    rangesOverlap(policy, { minAmount: input.minAmount, maxAmount: input.maxAmount ?? null }),
  );

  if (conflictingPolicy) {
    throw new Error(`Approval amount range overlaps active policy: ${conflictingPolicy.name}`);
  }
}

function buildConditions(input: ApprovalPolicyInput) {
  const conditions = [
    { field: 'scope', operator: '=', value: input.scope ?? 'SHOP' },
    { field: AMOUNT_FIELD, operator: '>=', value: String(input.minAmount) },
  ];
  if ((input.scope ?? 'SHOP') === 'SHOP') {
    conditions.unshift({ field: SHOP_SCOPE_FIELD, operator: '=', value: input.shopId ?? '' });
  }
  if (input.maxAmount !== null && input.maxAmount !== undefined) {
    conditions.push({ field: AMOUNT_FIELD, operator: '<=', value: String(input.maxAmount) });
  }
  return conditions;
}

function policyData(input: ApprovalPolicyInput) {
  return {
    name: input.name.trim(),
    scope: input.scope ?? 'SHOP',
    shopId: input.scope === 'PLATFORM' ? null : input.shopId,
    approverUserId: input.approverUserId ?? null,
    minAmount: input.minAmount,
    maxAmount: input.maxAmount ?? null,
    level: input.level ?? 1,
    isActive: input.isActive ?? true,
  };
}

export async function listApprovalPolicies(shopId: string, authContext: ExpenseAuthContext) {
  const normalizedShopId = assertShopOwner(authContext, shopId);
  return prisma.approvalPolicy.findMany({
    where: {
      scope: 'SHOP',
      shopId: normalizedShopId,
      conditions: { some: { field: SHOP_SCOPE_FIELD, operator: '=', value: normalizedShopId } },
    },
    include: policyInclude,
    orderBy: [{ level: 'asc' }, { minAmount: 'asc' }],
  });
}

export async function getApprovalPolicy(id: string, shopId: string, authContext: ExpenseAuthContext) {
  const normalizedShopId = assertShopOwner(authContext, shopId);
  const policy = await prisma.approvalPolicy.findFirst({
    where: {
      id,
      scope: 'SHOP',
      shopId: normalizedShopId,
      conditions: { some: { field: SHOP_SCOPE_FIELD, operator: '=', value: normalizedShopId } },
    },
    include: policyInclude,
  });
  if (!policy) throw new Error('Approval policy not found');
  return policy;
}

export async function listPlatformApprovalPolicies(authContext: ExpenseAuthContext) {
  assertPlatformPolicyAdmin(authContext);
  return prisma.approvalPolicy.findMany({
    where: { scope: 'PLATFORM', shopId: null },
    include: policyInclude,
    orderBy: [{ level: 'asc' }, { minAmount: 'asc' }],
  });
}

export async function getPlatformApprovalPolicy(id: string, authContext: ExpenseAuthContext) {
  assertPlatformPolicyAdmin(authContext);
  const policy = await prisma.approvalPolicy.findFirst({
    where: { id, scope: 'PLATFORM', shopId: null },
    include: policyInclude,
  });
  if (!policy) throw new Error('Approval policy not found');
  return policy;
}

export async function setPlatformApprovalPolicyActive(id: string, isActive: boolean, authContext: ExpenseAuthContext) {
  const existing = await getPlatformApprovalPolicy(id, authContext);
  return prisma.$transaction(async (tx) => {
    await lockPolicyShop(tx, 'PLATFORM');
    if (isActive) {
      await assertNoActiveOverlap({ scope: 'PLATFORM', shopId: '', name: existing.name, minAmount: Number(existing.minAmount), maxAmount: existing.maxAmount == null ? null : Number(existing.maxAmount), level: existing.level, isActive: true }, existing.id, tx);
    }
    return tx.approvalPolicy.update({ where: { id: existing.id }, data: { isActive }, include: policyInclude });
  });
}

export async function deletePlatformApprovalPolicy(id: string, authContext: ExpenseAuthContext) {
  const existing = await getPlatformApprovalPolicy(id, authContext);
  if (existing.isActive) throw new Error('Deactivate the approval policy before deleting it');
  await prisma.approvalPolicy.delete({ where: { id: existing.id } });
}

export async function createApprovalPolicy(input: ApprovalPolicyInput, authContext: ExpenseAuthContext, bearerToken: string) {
  const scope = input.scope ?? 'SHOP';
  const normalizedShopId = scope === 'SHOP' ? assertShopOwner(authContext, input.shopId ?? '') : null;
  if (scope === 'PLATFORM' && !['platform_super_admin', 'super_admin'].includes(authContext.role?.toLowerCase() ?? '')) {
    throw new Error('Only a platform administrator can manage platform approval policies');
  }
  const normalizedInput = { ...input, scope, shopId: normalizedShopId ?? '', name: input.name.trim(), approverUserId: input.approverUserId?.trim() || null };
  validateAmountRange(normalizedInput.minAmount, normalizedInput.maxAmount);
  validateLevel(normalizedInput.level ?? 1);
  return prisma.$transaction(async (tx) => {
    await lockPolicyShop(tx, normalizedShopId ?? 'PLATFORM');
    await assertNoActiveOverlap(normalizedInput, undefined, tx);
    return tx.approvalPolicy.create({
      data: {
        ...policyData(normalizedInput),
        conditions: { create: buildConditions(normalizedInput) },
      },
      include: policyInclude,
    });
  });
}

export async function updateApprovalPolicy(id: string, input: ApprovalPolicyInput, authContext: ExpenseAuthContext, bearerToken: string) {
  const scope = input.scope ?? 'SHOP';
  const existing = scope === 'SHOP' ? await getApprovalPolicy(id, input.shopId ?? '', authContext) : await prisma.approvalPolicy.findUnique({ where: { id } });
  if (!existing) throw new Error('Approval policy not found');
  const normalizedShopId = scope === 'SHOP' ? assertShopOwner(authContext, input.shopId ?? '') : null;
  if (scope === 'PLATFORM' && !['platform_super_admin', 'super_admin'].includes(authContext.role?.toLowerCase() ?? '')) {
    throw new Error('Only a platform administrator can manage platform approval policies');
  }
  const normalizedInput = { ...input, scope, shopId: normalizedShopId ?? '', name: input.name.trim(), approverUserId: input.approverUserId?.trim() || null };
  validateAmountRange(normalizedInput.minAmount, normalizedInput.maxAmount);
  validateLevel(normalizedInput.level ?? 1);
  return prisma.$transaction(async (tx) => {
    await lockPolicyShop(tx, normalizedShopId ?? 'PLATFORM');
    await assertNoActiveOverlap(normalizedInput, existing.id, tx);
    await tx.approvalPolicyCondition.deleteMany({ where: { approvalPolicyId: existing.id } });
    return tx.approvalPolicy.update({
      where: { id: existing.id },
      data: {
        ...policyData(normalizedInput),
        conditions: { create: buildConditions(normalizedInput) },
      },
      include: policyInclude,
    });
  });
}

export async function setApprovalPolicyActive(id: string, shopId: string, isActive: boolean, authContext: ExpenseAuthContext) {
  const existing = await getApprovalPolicy(id, shopId, authContext);
  return prisma.$transaction(async (tx) => {
    await lockPolicyShop(tx, shopId);
    if (isActive) {
      await assertNoActiveOverlap({
        shopId,
        name: existing.name,
        minAmount: Number(existing.minAmount),
        maxAmount: existing.maxAmount == null ? null : Number(existing.maxAmount),
        level: existing.level,
        isActive: true,
      }, existing.id, tx);
    }
    return tx.approvalPolicy.update({ where: { id: existing.id }, data: { isActive }, include: policyInclude });
  });
}

export async function deleteApprovalPolicy(id: string, shopId: string, authContext: ExpenseAuthContext) {
  const existing = await getApprovalPolicy(id, shopId, authContext);
  if (existing.isActive) throw new Error('Deactivate the approval policy before deleting it');
  await prisma.approvalPolicy.delete({ where: { id: existing.id } });
}

export async function listApprovalPolicyApproverOptions(shopId: string, authContext: ExpenseAuthContext, bearerToken: string) {
  const normalizedShopId = assertShopOwner(authContext, shopId);
  const members = await loadShopMembers(normalizedShopId, bearerToken);
  const users: ApproverOption[] = [];
  const roles = new Map<string, { code: string; name: string }>();
  const positions = new Set<string>();

  for (const member of members) {
    const user = member.user;
    const id = user?.id ?? member.user_id ?? null;
    if (!id) continue;
    users.push({
      id,
      name: user?.name ?? id,
      email: user?.email ?? null,
      roleCode: member.role?.code ?? null,
      roleName: member.role?.name ?? null,
      position: member.position ?? null,
    });
    if (member.role?.code) roles.set(member.role.code, { code: member.role.code, name: member.role.name ?? member.role.code });
    if (member.position) positions.add(member.position);
  }

  return {
    roles: Array.from(roles.values()).sort((left, right) => left.name.localeCompare(right.name)),
    positions: Array.from(positions).sort(),
    users: users.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
