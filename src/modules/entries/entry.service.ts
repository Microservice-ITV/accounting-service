import prisma from '../../lib/prisma.js';

export type Direction = 'DEBIT' | 'CREDIT';

export type EntryLineInput = {
  accountCode: string;
  direction: Direction;
  amount: number;
  memo?: string;
};

export type CreateJournalEntryInput = {
  referenceType: string;
  referenceId: string;
  eventId?: string;
  narration?: string;
  lines: EntryLineInput[];
};

function isValidDirection(direction: string): direction is Direction {
  return direction === 'DEBIT' || direction === 'CREDIT';
}

function validateLines(lines: EntryLineInput[]) {
  if (!lines || lines.length === 0) {
    throw new Error('Journal entry must contain at least one line');
  }

  let debitTotal = 0;
  let creditTotal = 0;

  for (const line of lines) {
    if (!line.accountCode || !isValidDirection(line.direction)) {
      throw new Error('Each journal entry line must include a valid account code and direction');
    }

    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      throw new Error('Each journal entry line amount must be a positive number');
    }

    if (line.direction === 'DEBIT') debitTotal += line.amount;
    if (line.direction === 'CREDIT') creditTotal += line.amount;
  }

  if (debitTotal !== creditTotal) {
    throw new Error(`Journal entry is out of balance: DEBIT ${debitTotal} != CREDIT ${creditTotal}`);
  }
}

export async function createJournalEntry(input: CreateJournalEntryInput) {
  validateLines(input.lines);

  const accountCodes = [...new Set(input.lines.map((line) => line.accountCode))];

  const accounts = await prisma.account.findMany({
    where: { code: { in: accountCodes } },
  });

  const accountMap = new Map(accounts.map((account) => [account.code, account]));

  const missingCodes = accountCodes.filter((code) => !accountMap.has(code));
  if (missingCodes.length > 0) {
    throw new Error(`Unknown account codes: ${missingCodes.join(', ')}`);
  }

  return prisma.$transaction(async (tx) => {
    const journalEntry = await tx.journalEntry.create({
      data: {
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        eventId: input.eventId,
        narration: input.narration || 'Accounting entry',
        status: 'POSTED',
      },
    });

    await Promise.all(
      input.lines.map((line: EntryLineInput) =>
        tx.entryLine.create({
          data: {
            journalEntryId: journalEntry.id,
            accountId: accountMap.get(line.accountCode)!.id,
            direction: line.direction,
            amount: line.amount,
            memo: line.memo || null,
          },
        }),
      ),
    );

    return {
      id: journalEntry.id,
      referenceType: journalEntry.referenceType,
      referenceId: journalEntry.referenceId,
      eventId: journalEntry.eventId,
      narration: journalEntry.narration,
      status: journalEntry.status,
      lines: input.lines,
    };
  });
}

export async function listEntries() {
  return prisma.journalEntry.findMany({
    include: {
      lines: {
        include: {
          account: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getEntryByReference(referenceType: string, referenceId: string) {
  return prisma.journalEntry.findFirst({
    where: { referenceType, referenceId },
    include: {
      lines: {
        include: {
          account: true,
        },
      },
    },
  });
}
