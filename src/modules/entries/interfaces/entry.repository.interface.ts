import type { Prisma } from '@prisma/client';
import type {
  CreateJournalEntryInput,
  CreatedJournalEntry,
  EntryDbClient,
  JournalEntryRecord,
} from './entry.types.js';

export interface IEntryRepository {
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  createInTransaction(
    input: CreateJournalEntryInput,
    db: EntryDbClient,
    replaceJournalEntryId?: string,
  ): Promise<CreatedJournalEntry>;
  list(): Promise<JournalEntryRecord[]>;
  getByReference(referenceType: string, referenceId: string): Promise<JournalEntryRecord | null>;
}
