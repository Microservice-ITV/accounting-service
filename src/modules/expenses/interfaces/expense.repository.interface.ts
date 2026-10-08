import type { Prisma } from '@prisma/client';

export type ExpenseDbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;
export type ExpenseCategoryRecord = Prisma.ExpenseCategoryGetPayload<{}>;
export type ExpenseRecord = Prisma.ExpenseGetPayload<{}>;
export type ExpenseWithCategory = Prisma.ExpenseGetPayload<{ include: { expenseType: true } }>;
export type JournalEntryWithLines = Prisma.JournalEntryGetPayload<{ include: { lines: { include: { account: true } } } }>;

export interface IExpenseRepository {
  listExpenseCategories(client?: ExpenseDbClient): Promise<ExpenseCategoryRecord[]>;
  createExpenseCategory(input: {
    code: string;
    name: string;
    description: string | null;
    status: string;
  }, client?: ExpenseDbClient): Promise<ExpenseCategoryRecord>;
  updateExpenseCategory(id: string, input: {
    code: string;
    name: string;
    description: string | null;
    status: string;
  }, client?: ExpenseDbClient): Promise<ExpenseCategoryRecord>;
  deleteExpenseCategory(id: string, client?: ExpenseDbClient): Promise<ExpenseCategoryRecord>;
  findCategory(categoryId: string, client?: ExpenseDbClient): Promise<ExpenseCategoryRecord | null>;
  findAccountsByCodes(codes: string[], client?: ExpenseDbClient): Promise<Array<{
    code: string;
    type: string;
  }>>;
  findExpenseReferences(referencePrefix: string, client?: ExpenseDbClient): Promise<Array<{
    referenceId: string;
  }>>;
  createExpense(input: Prisma.ExpenseUncheckedCreateInput, client?: ExpenseDbClient): Promise<ExpenseRecord>;
  upsertExpense(input: Prisma.ExpenseUncheckedCreateInput, client?: ExpenseDbClient): Promise<ExpenseRecord>;
  findExpenseById(expenseId: string, client?: ExpenseDbClient): Promise<ExpenseRecord | null>;
  updateReturnedExpense(expenseId: string, input: Prisma.ExpenseUncheckedUpdateInput, client?: ExpenseDbClient): Promise<ExpenseWithCategory>;
  listExpenses(shopIds: string[], client?: ExpenseDbClient): Promise<ExpenseRecord[]>;
  listPlatformExpenses(client?: ExpenseDbClient): Promise<ExpenseWithCategory[]>;
  findExpenseByReference(referenceId: string, shopIds: string[], client?: ExpenseDbClient): Promise<ExpenseWithCategory | null>;
  findPlatformExpenseByReference(referenceId: string, client?: ExpenseDbClient): Promise<ExpenseWithCategory | null>;
  findJournalByExpenseReference(referenceId: string, client?: ExpenseDbClient): Promise<JournalEntryWithLines | null>;
  transaction<T>(callback: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}