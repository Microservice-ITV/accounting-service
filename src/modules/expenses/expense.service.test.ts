import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { EXPENSE_CONFIG } from '../../config/expense.config.js';
import { expenseSchema } from './dto/expense.dto.js';
import { ExpenseApplicationError } from './errors/expense.error.js';
import { buildExpenseReferenceId, expenseReferencePrefixForDate } from './helpers/expense-reference.generator.js';
import { validateReceiptImage } from './helpers/receipt-validator.js';
import { ExpenseAuthorizationPolicy } from './policies/expense-authorization.policy.js';
import { ExpenseRepository } from './repositories/expense.repository.js';
import { ExpenseService } from './services/expense.service.js';

test('expense reference generator uses the configured prefix and sequence length', () => {
  const date = new Date(2025, 0, 2);

  assert.equal(expenseReferencePrefixForDate(date), 'EXP-20250102');
  assert.equal(buildExpenseReferenceId(date, 7), 'EXP-20250102-0007');
});

test('receipt validator accepts supported images and rejects invalid formats and oversized images', () => {
  assert.equal(validateReceiptImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');

  assert.throws(
    () => validateReceiptImage('data:image/gif;base64,AAAA'),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 400,
  );

  const oversizedImage = Buffer.alloc(EXPENSE_CONFIG.receipt.maxSizeBytes + 1).toString('base64');
  assert.throws(
    () => validateReceiptImage(`data:image/jpeg;base64,${oversizedImage}`),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 400,
  );
});

test('expense authorization policy denies empty and unassigned shop scopes', () => {
  const policy = new ExpenseAuthorizationPolicy();

  assert.throws(
    () => policy.requireAuthorizedShop({ userId: 'user-1', authorizedShopIds: [] }, 'shop-1'),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 403,
  );
  assert.throws(
    () => policy.requireAuthorizedShop({ userId: 'user-1', authorizedShopIds: ['shop-2'] }, 'shop-1'),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 403,
  );
  assert.deepEqual(
    policy.requireAuthorizedShop({ userId: 'user-1', authorizedShopIds: ['shop-1', 'shop-2'] }, 'shop-1'),
    ['shop-1', 'shop-2'],
  );
});

test('expense platform authorization uses explicit platform scope and finance permission', () => {
  const policy = new ExpenseAuthorizationPolicy();

  assert.equal(policy.canAccessPlatformExpenses({
    platformRoles: [{ code: 'arbitrary-role-name', scope: 'platform', permissions: ['finance.read'] }],
  }), true);
  assert.equal(policy.canAccessPlatformExpenses({
    platformRoles: [{ code: 'warehouse_manager', scope: 'platform', permissions: [] }],
  }), false);
  assert.equal(policy.canAccessPlatformExpenses({
    platformRoles: [{ code: 'finance_manager', scope: 'shop', permissions: ['finance.read'] }],
  }), false);
});

test('expense service denies shop creation without an authorized shop scope', async () => {
  const service = new ExpenseService(new ExpenseRepository());

  await assert.rejects(
    service.createExpense(
      { shopId: 'shop-1', amount: 100, category: 'travel' },
      { userId: 'user-1', authorizedShopIds: [] },
    ),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 403,
  );
});

test('expense service retries collisions on the unique expense reference', async () => {
  const references: Array<{ referenceId: string }> = [];
  const attemptedReferences: string[] = [];
  let createAttempts = 0;
  const repository = new Proxy(new ExpenseRepository(), {
    get(target, property, receiver) {
      if (property === 'findCategory') {
        return async () => ({ id: 'category-1', status: EXPENSE_CONFIG.defaults.categoryStatus });
      }
      if (property === 'findAccountsByCodes') {
        return async () => [
          { code: EXPENSE_CONFIG.defaults.expenseAccountCode, type: 'EXPENSE' },
          { code: EXPENSE_CONFIG.defaults.fundingAccountCode, type: 'ASSET' },
        ];
      }
      if (property === 'findExpenseReferences') {
        return async () => references;
      }
      if (property === 'transaction') {
        return (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback({} as Prisma.TransactionClient);
      }
      if (property === 'createExpense') {
        return async (input: Prisma.ExpenseUncheckedCreateInput) => {
          createAttempts += 1;
          attemptedReferences.push(input.expenseNo);
          references.push({ referenceId: input.expenseNo });
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['expenseNo'] },
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const service = new ExpenseService(repository);
  await assert.rejects(
    service.createExpense(
      { shopId: 'shop-1', amount: 100, category: 'TRAVEL', expenseDate: '2025-01-02' },
      { userId: 'user-1', authorizedShopIds: ['shop-1'] },
    ),
    (error: unknown) => error instanceof ExpenseApplicationError && error.statusCode === 503,
  );

  assert.equal(createAttempts, EXPENSE_CONFIG.reference.retryLimit);
  assert.deepEqual(attemptedReferences, Array.from(
    { length: EXPENSE_CONFIG.reference.retryLimit },
    (_, index) => `EXP-20250102-${String(index + 1).padStart(EXPENSE_CONFIG.reference.sequenceLength, '0')}`,
  ));
});

test('expense DTO validates amounts and dates consistently', () => {
  const validExpense = { shopId: 'shop-1', amount: 10, expenseDate: '2025-01-02' };

  assert.equal(expenseSchema.safeParse(validExpense).success, true);
  assert.equal(expenseSchema.safeParse({ ...validExpense, amount: 0 }).success, false);
  assert.equal(expenseSchema.safeParse({ ...validExpense, expenseDate: 'not-a-date' }).success, false);
});
