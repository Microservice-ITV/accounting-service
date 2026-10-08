import prisma from '../lib/prisma.js';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

const defaultAccounts: Array<{
  code: string;
  name: string;
  type: AccountType;
}> = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { code: '2100', name: 'Seller Payables', type: 'LIABILITY' },
  { code: '3000', name: 'Owner Equity', type: 'EQUITY' },
  { code: '4000', name: 'Revenue', type: 'INCOME' },
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE' },
];

const defaultExpenseCategories = [
  { code: 'DELI', name: 'Deli', description: 'Shop-paid delivery-provider charges' },
  { code: 'OFFICE', name: 'Office', description: 'General office expenses' },
  { code: 'TRAVEL', name: 'Travel', description: 'Travel and transportation expenses' },
  { code: 'PURCHASE', name: 'Purchase', description: 'Business purchases and procurement' },
  { code: 'OFFICE_SUPPLIES', name: 'Office Supplies', description: 'Office, stationery, and small supplies' },
  { code: 'MARKETING', name: 'Marketing', description: 'Advertising and promotional costs' },
  { code: 'UTILITIES', name: 'Utilities', description: 'Internet, electricity, and water bills' },
  { code: 'SOFTWARE', name: 'Software', description: 'Software subscriptions and tools' },
  { code: 'OTHER', name: 'Other', description: 'Other operational expenses' },
];

export function shouldSeedRequiredMasterData() {
  const envValue = process.env.ACCOUNTING_ENABLE_SEED;

  if (envValue !== undefined) {
    return envValue === 'true';
  }

  return process.env.NODE_ENV !== 'production';
}

async function ensureAccount(account: {
  code: string;
  name: string;
  type: AccountType;
}) {
  return prisma.account.upsert({
    where: { code: account.code },
    update: {
      name: account.name,
      type: account.type,
    },
    create: {
      code: account.code,
      name: account.name,
      type: account.type,
    },
  });
}

async function ensureExpenseCategory(category: {
  code: string;
  name: string;
  description?: string | null;
}) {
  return prisma.expenseCategory.upsert({
    where: { code: category.code },
    update: {
      name: category.name,
      description: category.description,
    },
    create: {
      code: category.code,
      name: category.name,
      description: category.description,
    },
  });
}

export async function seedRequiredMasterData() {
  if (!shouldSeedRequiredMasterData()) {
    console.log(
      'Accounting seed is disabled; skipping required master-data setup.',
    );
    return;
  }

  for (const account of defaultAccounts) {
    await ensureAccount(account);
  }

  for (const category of defaultExpenseCategories) {
    await ensureExpenseCategory(category);
  }

  console.log(
    'Accounting seed complete: required chart-of-account and expense-category data was ensured.',
  );
}