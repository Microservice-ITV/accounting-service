import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EntryApplicationError } from './errors/entry.error.js';
import type { IEntryRepository } from './interfaces/entry.repository.interface.js';
import type { CreateJournalEntryInput } from './interfaces/entry.types.js';
import { EntryService } from './services/entry.service.js';

const balancedInput: CreateJournalEntryInput = {
  referenceType: 'TEST',
  referenceId: 'entry-1',
  lines: [
    { accountCode: '1000', direction: 'DEBIT', amount: 10 },
    { accountCode: '4000', direction: 'CREDIT', amount: 10 },
  ],
};

test('EntryService validates and creates a journal entry inside its repository transaction', async () => {
  let transactionCalled = false;
  let createCalled = false;
  const repository: IEntryRepository = {
    transaction: async (work) => {
      transactionCalled = true;
      return work({} as never);
    },
    createInTransaction: async (input) => {
      createCalled = true;
      assert.equal(input.referenceId, balancedInput.referenceId);
      return {
        id: 'journal-1',
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        eventId: null,
        narration: 'Accounting entry',
        status: 'POSTED',
        lines: input.lines,
      };
    },
    list: async () => [],
    getByReference: async () => null,
  };

  const created = await new EntryService(repository).create(balancedInput);
  assert.equal(created.id, 'journal-1');
  assert.equal(transactionCalled, true);
  assert.equal(createCalled, true);
});

test('EntryService rejects unbalanced entries before database access', async () => {
  let transactionCalled = false;
  const repository: IEntryRepository = {
    transaction: async () => {
      transactionCalled = true;
      throw new Error('Transaction should not run for invalid input');
    },
    createInTransaction: async () => {
      throw new Error('Write should not run for invalid input');
    },
    list: async () => [],
    getByReference: async () => null,
  };

  await assert.rejects(
    new EntryService(repository).create({
      ...balancedInput,
      lines: [
        { accountCode: '1000', direction: 'DEBIT', amount: 10 },
        { accountCode: '4000', direction: 'CREDIT', amount: 9 },
      ],
    }),
    (error: unknown) => error instanceof EntryApplicationError && /out of balance/.test(error.message),
  );
  assert.equal(transactionCalled, false);
});
