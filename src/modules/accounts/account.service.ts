import prisma from '../../lib/prisma.js';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type AccountStatus = 'ACTIVE' | 'INACTIVE';

export type AccountInput = {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string | null;
  description?: string | null;
  status?: AccountStatus;
};

const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const ACCOUNT_STATUSES: AccountStatus[] = ['ACTIVE', 'INACTIVE'];

const isAccountType = (value: string): value is AccountType => ACCOUNT_TYPES.includes(value as AccountType);
const isAccountStatus = (value: string): value is AccountStatus => ACCOUNT_STATUSES.includes(value as AccountStatus);

const normalizeInput = (input: AccountInput): AccountInput => ({
  ...input,
  code: input.code.trim(),
  name: input.name.trim(),
  parentCode: input.parentCode?.trim() || null,
  description: input.description?.trim() || null,
});

async function resolveParent(parentCode: string | null | undefined, currentCode?: string) {
  if (!parentCode) return null;
  if (parentCode === currentCode) throw new Error('An account cannot be its own parent');

  const parent = await prisma.account.findUnique({ where: { code: parentCode } });
  if (!parent) throw new Error(`Parent account ${parentCode} was not found`);
  return parent;
}

function validateInput(input: AccountInput) {
  if (!input.code) throw new Error('Account code is required');
  if (!input.name) throw new Error('Account name is required');
  if (!isAccountType(input.type)) throw new Error('Invalid account type');
  if (input.status && !isAccountStatus(input.status)) throw new Error('Invalid account status');
}

const parentSelect = { id: true, code: true, name: true } as const;

export async function listAccounts() {
  return prisma.account.findMany({ include: { parent: { select: parentSelect } }, orderBy: { code: 'asc' } });
}

export async function getAccountByCode(code: string) {
  return prisma.account.findUnique({ where: { code }, include: { parent: { select: parentSelect } } });
}

export async function createAccount(rawInput: AccountInput) {
  const input = normalizeInput(rawInput);
  validateInput(input);
  const parent = await resolveParent(input.parentCode);

  return prisma.account.create({
    data: { code: input.code, name: input.name, type: input.type, status: input.status ?? 'ACTIVE', description: input.description, parentId: parent?.id ?? null },
    include: { parent: { select: parentSelect } },
  });
}

export async function updateAccount(currentCode: string, rawInput: AccountInput) {
  const input = normalizeInput(rawInput);
  validateInput(input);
  const existing = await prisma.account.findUnique({ where: { code: currentCode } });
  if (!existing) return null;
  const parent = await resolveParent(input.parentCode, currentCode);

  return prisma.account.update({
    where: { code: currentCode },
    data: { code: input.code, name: input.name, type: input.type, status: input.status ?? existing.status, description: input.description, parentId: parent?.id ?? null },
    include: { parent: { select: parentSelect } },
  });
}

export async function toggleAccountStatus(code: string) {
  const existing = await prisma.account.findUnique({ where: { code } });
  if (!existing) return null;
  return prisma.account.update({
    where: { code },
    data: { status: existing.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
    include: { parent: { select: parentSelect } },
  });
}