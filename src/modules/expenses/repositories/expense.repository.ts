import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type { ExpenseListStatus } from '../dto/expense.dto.js';
import type { ExpenseDbClient, IExpenseRepository } from '../interfaces/expense.repository.interface.js';

export class ExpenseRepository implements IExpenseRepository {
  listExpenseCategories(client: ExpenseDbClient = prisma) {
    return client.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  }

  createExpenseCategory(input: { code: string; name: string; description: string | null; status: string }, client: ExpenseDbClient = prisma) {
    return client.expenseCategory.create({ data: input });
  }

  updateExpenseCategory(id: string, input: { code: string; name: string; description: string | null; status: string }, client: ExpenseDbClient = prisma) {
    return client.expenseCategory.update({ where: { id }, data: input });
  }

  deleteExpenseCategory(id: string, client: ExpenseDbClient = prisma) {
    return client.expenseCategory.delete({ where: { id } });
  }

  findCategory(categoryId: string, client: ExpenseDbClient = prisma) {
    return client.expenseCategory.findFirst({
      where: {
        OR: [
          { id: categoryId },
          { code: categoryId },
          { name: { equals: categoryId, mode: 'insensitive' } },
        ],
      },
    });
  }

  findAccountsByCodes(codes: string[], client: ExpenseDbClient = prisma) {
    return client.account.findMany({ where: { code: { in: codes } } });
  }

  findExpenseReferences(referencePrefix: string, client: ExpenseDbClient = prisma) {
    return client.expense.findMany({
      where: { expenseNo: { startsWith: `${referencePrefix}-` } },
      select: { expenseNo: true },
    }).then((expenses) => expenses.map((expense) => ({ referenceId: expense.expenseNo })));
  }

  createExpense(input: Prisma.ExpenseUncheckedCreateInput, client: ExpenseDbClient = prisma) {
    return client.expense.create({ data: input });
  }

  upsertExpense(input: Prisma.ExpenseUncheckedCreateInput, client: ExpenseDbClient = prisma) {
    return client.expense.upsert({
      where: { expenseNo: input.expenseNo },
      update: {},
      create: input,
    });
  }

  findExpenseById(expenseId: string, client: ExpenseDbClient = prisma) {
    return client.expense.findUnique({ where: { id: expenseId } });
  }

  updateReturnedExpense(expenseId: string, input: Prisma.ExpenseUncheckedUpdateInput, client: ExpenseDbClient = prisma) {
    return client.expense.update({
      where: { id: expenseId },
      data: input,
      include: { expenseType: true },
    });
  }

  listExpenses(shopIds: string[], statuses?: ExpenseListStatus[], client: ExpenseDbClient = prisma) {
    return client.expense.findMany({
      where: {
        shopId: { in: shopIds },
        ...(statuses ? { status: { in: statuses } } : {}),
      },
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
    });
  }

  listPlatformExpenses(statuses?: ExpenseListStatus[], client: ExpenseDbClient = prisma) {
    return client.expense.findMany({
      where: {
        scope: 'PLATFORM',
        ...(statuses ? { status: { in: statuses } } : {}),
      },
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
    });
  }

  findExpenseByReference(referenceId: string, shopIds: string[], client: ExpenseDbClient = prisma) {
    return client.expense.findFirst({
      where: { expenseNo: referenceId, shopId: { in: shopIds } },
      include: { expenseType: true },
    });
  }

  findPlatformExpenseByReference(referenceId: string, client: ExpenseDbClient = prisma) {
    return client.expense.findFirst({
      where: { expenseNo: referenceId, scope: 'PLATFORM' },
      include: { expenseType: true },
    });
  }

  findJournalByExpenseReference(referenceId: string, client: ExpenseDbClient = prisma) {
    return client.journalEntry.findFirst({
      where: { referenceType: 'EXPENSE', referenceId },
      include: { lines: { include: { account: true } } },
    });
  }

  transaction<T>(callback: (client: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(callback);
  }
}