import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import { EntryApplicationError } from '../errors/entry.error.js';
import { buildJournalEntryUpsertEvent } from '../helpers/journal-entry-event.builder.js';
import type { IEntryRepository } from '../interfaces/entry.repository.interface.js';
import type {
  CreateJournalEntryInput,
  CreatedJournalEntry,
  EntryDbClient,
  JournalEntryRecord,
} from '../interfaces/entry.types.js';

export class EntryRepository implements IEntryRepository {
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async createInTransaction(
    input: CreateJournalEntryInput,
    db: EntryDbClient,
    replaceJournalEntryId?: string,
  ): Promise<CreatedJournalEntry> {
    const accountCodes = [...new Set(input.lines.map((line) => line.accountCode))];
    const accounts = await db.account.findMany({ where: { code: { in: accountCodes } } });
    const accountMap = new Map(accounts.map((account) => [account.code, account]));
    const missingCodes = accountCodes.filter((code) => !accountMap.has(code));
    if (missingCodes.length > 0) {
      throw new EntryApplicationError(`Unknown account codes: ${missingCodes.join(', ')}`);
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
      input.lines.map((line) => db.entryLine.create({
        data: {
          journalEntryId: journalEntry.id,
          accountId: accountMap.get(line.accountCode)!.id,
          direction: line.direction,
          amount: line.amount,
          currency: line.currency,
          shopId: line.shopId,
          memo: line.memo || null,
        },
      })),
    );

    const projection = await db.journalEntry.findUnique({
      where: { id: journalEntry.id },
      include: {
        lines: {
          include: {
            account: {
              select: { id: true, code: true, name: true, type: true },
            },
          },
        },
      },
    });
    if (!projection) {
      throw new EntryApplicationError(`Journal entry ${journalEntry.id} was not found after writing`);
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

  list(): Promise<JournalEntryRecord[]> {
    return prisma.journalEntry.findMany({
      include: { lines: { include: { account: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  getByReference(referenceType: string, referenceId: string): Promise<JournalEntryRecord | null> {
    return prisma.journalEntry.findFirst({
      where: { referenceType, referenceId },
      include: { lines: { include: { account: true } } },
    });
  }
}
