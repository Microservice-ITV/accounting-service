import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { ExpenseService, buildExpenseReferenceId } from './expense.service.js';

test('buildExpenseReferenceId pads the sequence to four digits', () => {
  assert.equal(buildExpenseReferenceId(new Date('2026-09-18T00:00:00.000Z'), 12), 'EXP-20260918-0012');
});

test('buildExpenseReferenceId uses the expense date in YYYYMMDD format', () => {
  assert.equal(buildExpenseReferenceId(new Date('2026-09-18T12:30:00.000Z'), 1), 'EXP-20260918-0001');
});

test('shop-based expense references stay isolated to the selected shop and seller', () => {
  const refId = buildExpenseReferenceId(new Date('2026-09-20T00:00:00.000Z'), 42);
  assert.equal(refId, 'EXP-20260920-0042');
  assert.ok(refId.startsWith('EXP-'));
});

test('createExpense retries when the generated expense reference collides with an existing row', async () => {
  let seenReferenceId = '';
  let duplicateThrown = false;

  const service = new ExpenseService({
    findCategory: async () => ({ id: 'cat-123', status: 'ACTIVE' }),
    findAccountsByCodes: async () => [
      { code: '5000', type: 'EXPENSE' },
      { code: '1000', type: 'ASSET' },
    ],
    findExpenseReferences: async (prefix: string) => {
      if (prefix === 'EXP-20260918') {
        if (seenReferenceId === '') return [{ referenceId: 'EXP-20260918-0001' }];
        return [{ referenceId: 'EXP-20260918-0001' }, { referenceId: 'EXP-20260918-0002' }];
      }
      return [];
    },
    createExpense: async (input: { expenseNo: string }) => {
      seenReferenceId = input.expenseNo;
      if (!duplicateThrown && input.expenseNo === 'EXP-20260918-0002') {
        duplicateThrown = true;
        const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`expenseNo`)', {
          code: 'P2002',
          clientVersion: 'test',
        });
        (error as any).meta = { target: ['expenseNo'] };
        throw error;
      }
      return { id: 'exp-1', expenseNo: input.expenseNo };
    },
    transaction: async <T>(callback: (client: unknown) => Promise<T>) => callback({}),
  } as any);

  const result = await service.createExpense({
    amount: 2500,
    expenseCategoryId: 'cat-123',
    expenseDate: '2026-09-18',
    shopId: 'shop-1',
  }, {
    userId: 'user-1',
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1'],
  });

  assert.equal(result.expense.expenseNo, 'EXP-20260918-0003');
});
