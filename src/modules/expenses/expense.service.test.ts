import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { EXPENSE_CONFIG } from '../../config/expense.config.js';
import { expenseListStatusFilterSchema, expenseSchema } from './dto/expense.dto.js';
import { ExpenseApplicationError } from './errors/expense.error.js';
import { buildExpenseReferenceId, expenseReferencePrefixForDate } from './helpers/expense-reference.generator.js';
import { validateReceiptImage } from './helpers/receipt-validator.js';
import { ExpenseAuthorizationPolicy } from './policies/expense-authorization.policy.js';
import { ExpenseRepository } from './repositories/expense.repository.js';
import { ExpenseService } from './services/expense.service.js';
import type { ExpenseDbClient } from './interfaces/expense.repository.interface.js';

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

test('expense list status filter accepts the ledger lifecycle statuses and rejects unknown statuses', () => {
  assert.deepEqual(
    expenseListStatusFilterSchema.parse('PENDING,PENDING_APPROVAL,APPROVED,REJECTED'),
    ['PENDING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
  );
  assert.equal(expenseListStatusFilterSchema.safeParse('APPROVED,UNKNOWN').success, false);
});

test('expense repository applies status filters within the authorized shop or platform scope', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const client = {
    expense: {
      findMany: async (query: Record<string, unknown>) => {
        queries.push(query);
        return [];
      },
    },
  } as unknown as ExpenseDbClient;
  const repository = new ExpenseRepository();
  const statuses = ['PENDING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;

  await repository.listExpenses(['shop-1'], [...statuses], client);
  await repository.listPlatformExpenses([...statuses], client);

  assert.deepEqual(queries, [
    {
      where: { shopId: { in: ['shop-1'] }, status: { in: [...statuses] } },
      include: {
        expenseType: true,
        approvals: {
          where: { approvedAt: { not: null } },
          orderBy: { approvedAt: 'desc' },
          take: 1,
          select: { approvedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    },
    {
      where: { scope: 'PLATFORM', status: { in: [...statuses] } },
      include: {
        expenseType: true,
        approvals: {
          where: { approvedAt: { not: null } },
          orderBy: { approvedAt: 'desc' },
          take: 1,
          select: { approvedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    },
  ]);
});

test('expense service serializes the approval timestamp as UTC ISO without changing the expense date', async () => {
  const expenseDate = new Date('2026-10-30T00:00:00.000Z');
  const approvedAt = new Date('2026-10-30T15:28:33.000Z');
  const repository = new Proxy(new ExpenseRepository(), {
    get(target, property, receiver) {
      if (property === 'listExpenses') {
        return async () => [{
          id: 'expense-1',
          expenseDate,
          approvals: [{ approvedAt }],
        }];
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const service = new ExpenseService(repository);

  const [expense] = await service.listExpenses(
    { userId: 'owner-1', authorizedShopIds: ['shop-1'] },
    ['APPROVED'],
  ) as Array<{ expenseDate: Date; approvedAt: string | null }>;

  assert.equal(expense.expenseDate, expenseDate);
  assert.equal(expense.approvedAt, '2026-10-30T15:28:33.000Z');
  assert.equal(new Date(expense.approvedAt ?? '').toISOString(), approvedAt.toISOString());
});
