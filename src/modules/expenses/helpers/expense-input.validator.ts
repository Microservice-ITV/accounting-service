import { ExpenseApplicationError } from '../errors/expense.error.js';

export function isValidExpenseAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}

export function isValidExpenseDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

export function parseExpenseDate(value?: Date | string, fallback?: Date): Date {
  const expenseDate = value === undefined
    ? fallback ? new Date(fallback) : new Date()
    : new Date(value);

  if (!Number.isFinite(expenseDate.getTime())) {
    throw new ExpenseApplicationError('Invalid expense date', 400);
  }

  return expenseDate;
}

export function validateExpenseAmount(amount: number): void {
  if (!isValidExpenseAmount(amount)) {
    throw new ExpenseApplicationError('Expense amount must be greater than 0', 400);
  }
}
