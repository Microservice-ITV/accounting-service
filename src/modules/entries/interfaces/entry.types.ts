import type { Prisma, PrismaClient } from '@prisma/client';

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

export type EntryDbClient = PrismaClient | Prisma.TransactionClient;

export type JournalEntryRecord = Prisma.JournalEntryGetPayload<{
  include: {
    lines: {
      include: {
        account: true;
      };
    };
  };
}>;

export type CreatedJournalEntry = {
  id: string;
  referenceType: string;
  referenceId: string;
  eventId: string | null;
  narration: string | null;
  status: string;
  lines: EntryLineInput[];
};
