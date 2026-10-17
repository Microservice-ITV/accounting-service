import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { config } from '../../config/index.js';

export type Direction = 'DEBIT' | 'CREDIT';

export type EntryLineInput = {
  accountCode: string;
  direction: Direction;
  amount: number;
  currency?: string;
  shopId?: string;
  memo?: string;
};

export type CreateJournalEntryInput = {
  referenceType: string;
  referenceId: string;
  eventId?: string;
  narration?: string;
  entryDate?: Date | string;
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

type EntryDbClient = typeof prisma | Prisma.TransactionClient;

type JournalEntryProjection = Prisma.JournalEntryGetPayload<{
  include: {
    lines: {
      include: {
        account: {
          select: {
            id: true;
            code: true;
            name: true;
            type: true;
          };
        };
      };
    };
  };
}>;

export function buildJournalEntryUpsertEvent(
  entry: JournalEntryProjection,
  eventId: string = randomUUID(),
) {
  return {
    eventId,
    eventType: 'accounting.journal-entry.upserted',
    routingKey: config.accountingJournalEntryRoutingKey,
    payload: {
      event_id: eventId,
      event: 'accounting.journal-entry.upserted',
      timestamp: new Date().toISOString(),
      data: {
        id: entry.id,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        eventId: entry.eventId,
        narration: entry.narration,
        entryDate: entry.entryDate.toISOString(),
        status: entry.status,
        version: entry.version,
        createdAt: entry.createdAt.toISOString(),
        lines: entry.lines.map((line) => ({
          id: line.id,
          direction: line.direction,
          amount: Number(line.amount),
          currency: line.currency,
          shopId: line.shopId,
          memo: line.memo,
          account: line.account,
        })),
      },
    } satisfies Prisma.InputJsonValue,
  };
}

export async function createJournalEntryInTransaction(
  input: CreateJournalEntryInput,
  db: EntryDbClient,
  replaceJournalEntryId?: string,
) {
  validateLines(input.lines);

  const accountCodes = [...new Set(input.lines.map((line) => line.accountCode))];

  const accounts = await db.account.findMany({
    where: { code: { in: accountCodes } },
  });

  const accountMap = new Map(accounts.map((account) => [account.code, account]));

  const missingCodes = accountCodes.filter((code) => !accountMap.has(code));
  if (missingCodes.length > 0) {
    throw new Error(`Unknown account codes: ${missingCodes.join(', ')}`);
  }

  const journalEntry = replaceJournalEntryId
    ? await db.journalEntry.update({
        where: { id: replaceJournalEntryId },
        data: {
          eventId: input.eventId,
          narration: input.narration || 'Accounting entry',
          entryDate: input.entryDate ? new Date(input.entryDate) : new Date(),
          status: 'POSTED',
          version: { increment: 1 },
        },
      })
    : await db.journalEntry.create({
        data: {
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          eventId: input.eventId,
          narration: input.narration || 'Accounting entry',
          entryDate: input.entryDate ? new Date(input.entryDate) : new Date(),
          status: 'POSTED',
        },
      });

  if (replaceJournalEntryId) {
    await db.entryLine.deleteMany({ where: { journalEntryId: replaceJournalEntryId } });
  }

  await Promise.all(
    input.lines.map((line: EntryLineInput) =>
      db.entryLine.create({
        data: {
          journalEntryId: journalEntry.id,
          accountId: accountMap.get(line.accountCode)!.id,
          direction: line.direction,
          amount: line.amount,
          currency: line.currency,
          shopId: line.shopId,
          memo: line.memo || null,
        },
      }),
    ),
  );

  const projection = await db.journalEntry.findUnique({
    where: { id: journalEntry.id },
    include: {
      lines: {
        include: {
          account: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true,
            },
          },
        },
      },
    },
  });
  if (!projection) {
    throw new Error(`Journal entry ${journalEntry.id} was not found after writing`);
  }

  const event = buildJournalEntryUpsertEvent(projection);
  await db.accountingOutboxEvent.create({
    data: {
      eventId: event.eventId,
      eventType: event.eventType,
      routingKey: event.routingKey,
      payload: event.payload,
    },
  });

  return {
    id: journalEntry.id,
    referenceType: journalEntry.referenceType,
    referenceId: journalEntry.referenceId,
    eventId: journalEntry.eventId,
    narration: journalEntry.narration,
    status: journalEntry.status,
    lines: input.lines,
  };
}

export async function createJournalEntry(input: CreateJournalEntryInput) {
  return prisma.$transaction((tx) => createJournalEntryInTransaction(input, tx));
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
