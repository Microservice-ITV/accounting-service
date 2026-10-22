import { EntryApplicationError } from '../errors/entry.error.js';
import type { CreateJournalEntryInput, EntryLineInput } from '../interfaces/entry.types.js';

function isValidDirection(direction: string): direction is EntryLineInput['direction'] {
  return direction === 'DEBIT' || direction === 'CREDIT';
}

export function validateJournalEntry(input: CreateJournalEntryInput): void {
  if (!input.referenceType || !input.referenceId) {
    throw new EntryApplicationError('referenceType and referenceId are required');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new EntryApplicationError('Journal entry must contain at least one line');
  }

  let debitTotal = 0;
  let creditTotal = 0;

  for (const line of input.lines) {
    if (!line.accountCode || !isValidDirection(line.direction)) {
      throw new EntryApplicationError('Each journal entry line must include a valid account code and direction');
    }
    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      throw new EntryApplicationError('Each journal entry line amount must be a positive number');
    }
    if (line.direction === 'DEBIT') debitTotal += line.amount;
    if (line.direction === 'CREDIT') creditTotal += line.amount;
  }

  if (debitTotal !== creditTotal) {
    throw new EntryApplicationError(`Journal entry is out of balance: DEBIT ${debitTotal} != CREDIT ${creditTotal}`);
  }
}
