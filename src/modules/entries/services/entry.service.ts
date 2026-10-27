import { EntryRepository } from '../repositories/entry.repository.js';
import { EntryApplicationError } from '../errors/entry.error.js';
import { validateJournalEntry } from '../helpers/entry-validator.js';
import type { IEntryRepository } from '../interfaces/entry.repository.interface.js';
import type { IEntryService } from '../interfaces/entry.service.interface.js';
import type {
  CreateJournalEntryInput,
  CreatedJournalEntry,
  EntryDbClient,
  JournalEntryRecord,
} from '../interfaces/entry.types.js';

export class EntryService implements IEntryService {
  constructor(private readonly entryRepository: IEntryRepository) {}

  async create(input: CreateJournalEntryInput): Promise<CreatedJournalEntry> {
    validateJournalEntry(input);
    return this.entryRepository.transaction((tx) => this.entryRepository.createInTransaction(input, tx));
  }

  async createInTransaction(
    input: CreateJournalEntryInput,
    db: EntryDbClient,
    replaceJournalEntryId?: string,
  ): Promise<CreatedJournalEntry> {
    validateJournalEntry(input);
    return this.entryRepository.createInTransaction(input, db, replaceJournalEntryId);
  }

  list(): Promise<JournalEntryRecord[]> {
    return this.entryRepository.list();
  }

  getByReference(referenceType: string, referenceId: string): Promise<JournalEntryRecord | null> {
    return this.entryRepository.getByReference(referenceType, referenceId);
  }
}

const entryService = new EntryService(new EntryRepository());

export function createJournalEntryInTransaction(
  input: CreateJournalEntryInput,
  db: EntryDbClient,
  replaceJournalEntryId?: string,
) {
  return entryService.createInTransaction(input, db, replaceJournalEntryId);
}

export async function createJournalEntry(input: CreateJournalEntryInput) {
  return entryService.create(input);
}

export async function listEntries() {
  return entryService.list();
}

export async function getEntryByReference(referenceType: string, referenceId: string) {
  return entryService.getByReference(referenceType, referenceId);
}

export { EntryApplicationError };
