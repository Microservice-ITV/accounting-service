import prisma from '../../lib/prisma.js';
import { createJournalEntryInTransaction } from '../entries/entry.service.js';

export type ExpenseAuthContext = {
  userId: string;
  activeShopId?: string | null;
  authorizedShopIds?: Iterable<string>;
  shops?: Array<{
    shop_id?: string | null;
    role?: { code?: string | null; name?: string | null } | null;
  }>;
};

export type CreateExpenseInput = {
  amount: number;
  expenseDate?: Date | string;
  expenseAccountCode?: string;
  fundingAccountCode?: string;
  eventId?: string;
  expenseCategoryId?: string;
  category?: string;
  description?: string;
  shopId?: string | null;
};

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function buildExpenseReferenceId(date: Date, sequence: number) {
  return `EXP-${formatDateKey(new Date(date))}-${String(sequence).padStart(4, '0')}`;
}

export async function listExpenseCategories() {
  return prisma.expenseCategory.findMany({
    orderBy: { name: 'asc' },
  });
}

export type ExpenseCategoryInput = {
  code: string;
  name: string;
  description?: string | null;
  status?: string;
};

export async function createExpenseCategory(input: ExpenseCategoryInput) {
  return prisma.expenseCategory.create({
    data: {
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status: input.status?.trim() || 'ACTIVE',
    },
  });
}

export async function updateExpenseCategory(id: string, input: ExpenseCategoryInput) {
  return prisma.expenseCategory.update({
    where: { id },
    data: {
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description?.trim() || null,
      status: input.status?.trim() || 'ACTIVE',
    },
  });
}

export async function deleteExpenseCategory(id: string) {
  return prisma.expenseCategory.delete({ where: { id } });
}

export async function createExpense(input: CreateExpenseInput, authContext?: ExpenseAuthContext | null) {
  if (!authContext) {
    throw new Error('Unauthenticated');
  }

  if (!authContext.userId) {
    throw new Error('Authenticated user is required');
  }

  const shopId = input.shopId?.trim();
  if (!shopId) {
    throw new Error('Shop is required for the expense');
  }

  const authorizedShopIds = new Set(Array.from(authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (authorizedShopIds.size > 0 && !authorizedShopIds.has(shopId)) {
    throw new Error('User is not authorized for the selected shop');
  }

  const activeShopId = authContext.activeShopId?.trim() || Array.from(authorizedShopIds)[0];
  if (!activeShopId) {
    throw new Error('Seller is not assigned to any authorized shop');
  }

  const expenseAccountCode = input.expenseAccountCode || '5000';
  const fundingAccountCode = input.fundingAccountCode || '1000';
  const description = input.description?.trim();
  const categoryId = input.expenseCategoryId?.trim() || input.category?.trim();
  const expenseDate = input.expenseDate ? new Date(input.expenseDate) : new Date();

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Expense amount must be greater than 0');
  }

  if (!categoryId) {
    throw new Error('Expense category is required');
  }

  const expenseCategory = await prisma.expenseCategory.findFirst({
    where: {
      OR: [
        { id: categoryId },
        { code: categoryId },
        { name: { equals: categoryId, mode: 'insensitive' } },
      ],
    },
  });

  if (!expenseCategory || expenseCategory.status !== 'ACTIVE') {
    throw new Error('Unknown or inactive expense category');
  }

  if (expenseAccountCode === fundingAccountCode) {
    throw new Error('Expense and funding accounts must be different');
  }

  const accounts = await prisma.account.findMany({
    where: { code: { in: [expenseAccountCode, fundingAccountCode] } },
  });

  const accountMap = new Map(accounts.map((account) => [account.code, account]));
  const expenseAccount = accountMap.get(expenseAccountCode);
  const fundingAccount = accountMap.get(fundingAccountCode);

  if (!expenseAccount || !fundingAccount) {
    const missingCodes = [expenseAccountCode, fundingAccountCode].filter((code) => !accountMap.has(code));
    throw new Error(`Unknown account codes: ${missingCodes.join(', ')}`);
  }

  if (expenseAccount.type !== 'EXPENSE') {
    throw new Error(`Account ${expenseAccountCode} must be an EXPENSE account`);
  }

  if (fundingAccount.type === 'INCOME' || fundingAccount.type === 'EXPENSE') {
    throw new Error(`Account ${fundingAccountCode} cannot fund an expense`);
  }

  const referencePrefix = `EXP-${formatDateKey(expenseDate)}`;
  const expenseEntries = await prisma.journalEntry.findMany({
    where: {
      referenceType: 'EXPENSE',
      referenceId: { startsWith: `${referencePrefix}-` },
    },
    select: { referenceId: true },
  });

  const nextSequence = expenseEntries.reduce((max, entry) => {
    const match = entry.referenceId.match(/-(\d{4})$/);
    const nextValue = match ? Number.parseInt(match[1], 10) : 0;
    return Math.max(max, nextValue);
  }, 0) + 1;

  const referenceId = buildExpenseReferenceId(expenseDate, nextSequence);
  const narrationText = [expenseCategory.name, description].filter(Boolean).join(' - ') || 'Expense recorded';

  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        expenseNo: referenceId,
        shopId,
        sellerUserId: authContext.userId,
        expenseTypeId: expenseCategory.id,
        amount: input.amount,
        currency: 'MMK',
        description: description ?? null,
        expenseDate,
        status: 'DRAFT',
      },
    });

    const createdEntry = await createJournalEntryInTransaction({
      referenceType: 'EXPENSE',
      referenceId,
      eventId: input.eventId,
      narration: narrationText,
      entryDate: expenseDate,
      lines: [
        {
          accountCode: expenseAccountCode,
          direction: 'DEBIT',
          amount: input.amount,
          memo: expenseCategory.name,
        },
        {
          accountCode: fundingAccountCode,
          direction: 'CREDIT',
          amount: input.amount,
          memo: `${expenseCategory.name} paid`,
        },
      ],
    }, tx);

    return {
      expense,
      journalEntry: createdEntry,
    };
  });
}

export async function listExpenses(authContext?: ExpenseAuthContext | null) {
  if (!authContext || !authContext.authorizedShopIds) {
    throw new Error('Unauthorized');
  }

  const authorizedShopIds = Array.from(authContext.authorizedShopIds)
    .map((shopId) => shopId.trim())
    .filter(Boolean);

  if (authorizedShopIds.length === 0) {
    throw new Error('Unauthorized');
  }

  return prisma.expense.findMany({
    where: {
      shopId: { in: authorizedShopIds },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getExpenseByReference(referenceId: string, authContext?: ExpenseAuthContext | null) {
  const authorizedShopIds = Array.from(authContext?.authorizedShopIds ?? [])
    .map((shopId) => shopId.trim())
    .filter(Boolean);

  if (authorizedShopIds.length === 0) {
    throw new Error('Unauthorized');
  }

  const expense = await prisma.expense.findFirst({
    where: {
      expenseNo: referenceId,
      shopId: { in: authorizedShopIds },
    },
    include: {
      expenseType: true,
    },
  });

  if (!expense) return null;

  const journalEntry = await prisma.journalEntry.findFirst({
    where: {
      referenceType: 'EXPENSE',
      referenceId: expense.expenseNo,
    },
    include: {
      lines: {
        include: { account: true },
      },
    },
  });

  return { ...expense, journalEntry };
}
