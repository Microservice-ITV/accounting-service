import type { ExpenseAuthContext, CreateExpenseInput, ExpenseCategoryInput } from '../dto/expense.dto.js';

export interface IExpenseService {
  listExpenseCategories(): Promise<unknown[]>;
  createExpenseCategory(input: ExpenseCategoryInput): Promise<unknown>;
  updateExpenseCategory(id: string, input: ExpenseCategoryInput): Promise<unknown>;
  deleteExpenseCategory(id: string): Promise<unknown>;
  createExpense(input: CreateExpenseInput, authContext?: ExpenseAuthContext | null): Promise<unknown>;
  updateReturnedExpense(expenseId: string, input: Pick<CreateExpenseInput, 'amount' | 'expenseDate' | 'expenseCategoryId' | 'description' | 'receiptImage'>, authContext?: ExpenseAuthContext | null): Promise<unknown>;
  listExpenses(authContext?: ExpenseAuthContext | null): Promise<unknown[]>;
  getExpenseByReference(referenceId: string, authContext?: ExpenseAuthContext | null): Promise<unknown>;
}