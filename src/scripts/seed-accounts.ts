import prisma from '../lib/prisma.js';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

const defaultAccounts: Array<{ code: string; name: string; type: AccountType }> = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { code: '3000', name: 'Owner Equity', type: 'EQUITY' },
  { code: '4000', name: 'Revenue', type: 'INCOME' },
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE' },
];

const defaultExpenseCategories = [
  { code: 'OFFICE_SUPPLIES', name: 'Office Supplies', description: 'Office, stationery, and small supplies' },
  { code: 'MARKETING', name: 'Marketing', description: 'Advertising and promotional costs' },
  { code: 'UTILITIES', name: 'Utilities', description: 'Internet, electricity, and water bills' },
  { code: 'TRAVEL', name: 'Travel', description: 'Travel and transportation expenses' },
  { code: 'SOFTWARE', name: 'Software', description: 'Software subscriptions and tools' },
  { code: 'OTHER', name: 'Other', description: 'Other operational expenses' },
];

const sampleEntries = [
  {
    eventId: 'seed-opening-capital-2026',
    referenceType: 'SEED',
    referenceId: 'opening-capital-2026',
    narration: 'Opening capital contribution',
    entryDate: new Date('2026-01-01T00:00:00.000Z'),
    lines: [
      { accountCode: '1000', direction: 'DEBIT' as const, amount: 10000, memo: 'Capital deposited into cash' },
      { accountCode: '3000', direction: 'CREDIT' as const, amount: 10000, memo: 'Owner capital contribution' },
    ],
  },
  {
    eventId: 'seed-service-revenue-2026',
    referenceType: 'SEED',
    referenceId: 'service-revenue-2026',
    narration: 'Service revenue received',
    entryDate: new Date('2026-01-05T00:00:00.000Z'),
    lines: [
      { accountCode: '1000', direction: 'DEBIT' as const, amount: 2500, memo: 'Customer payment received' },
      { accountCode: '4000', direction: 'CREDIT' as const, amount: 2500, memo: 'Service revenue recognized' },
    ],
  },
  {
    eventId: 'seed-office-expense-2026',
    referenceType: 'SEED',
    referenceId: 'office-expense-2026',
    narration: 'Office operating expense paid',
    entryDate: new Date('2026-01-10T00:00:00.000Z'),
    lines: [
      { accountCode: '5000', direction: 'DEBIT' as const, amount: 750, memo: 'Office supplies and utilities' },
      { accountCode: '1000', direction: 'CREDIT' as const, amount: 750, memo: 'Paid from cash' },
    ],
  },
];

async function seedAccounts() {
  const accountsByCode = new Map<string, string>();

  for (const account of defaultAccounts) {
    const seededAccount = await prisma.account.upsert({
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

    accountsByCode.set(seededAccount.code, seededAccount.id);
  }

  for (const category of defaultExpenseCategories) {
    await prisma.expenseCategory.upsert({
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

  for (const entry of sampleEntries) {
    const existingEntry = await prisma.journalEntry.findUnique({
      where: { eventId: entry.eventId },
    });

    if (existingEntry) {
      continue;
    }

    await prisma.journalEntry.create({
      data: {
        eventId: entry.eventId,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        narration: entry.narration,
        entryDate: entry.entryDate,
        status: 'POSTED',
        lines: {
          create: entry.lines.map((line) => ({
            accountId: accountsByCode.get(line.accountCode)!,
            direction: line.direction,
            amount: line.amount,
            memo: line.memo,
          })),
        },
      },
    });
  }

  console.log('Default accounts and sample journal entries seeded successfully');
}

seedAccounts()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
