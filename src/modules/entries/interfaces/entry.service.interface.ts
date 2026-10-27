import type { CreateJournalEntryInput, CreatedJournalEntry, JournalEntryRecord } from './entry.types.js';

export interface IEntryService {
  create(input: CreateJournalEntryInput): Promise<CreatedJournalEntry>;
  list(): Promise<JournalEntryRecord[]>;
  getByReference(referenceType: string, referenceId: string): Promise<JournalEntryRecord | null>;
}
