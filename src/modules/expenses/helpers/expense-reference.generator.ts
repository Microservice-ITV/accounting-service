import { EXPENSE_CONFIG } from '../../../config/expense.config.js';

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function expenseReferencePrefixForDate(date: Date): string {
  return `${EXPENSE_CONFIG.reference.prefix}-${formatDateKey(date)}`;
}

export function buildExpenseReferenceId(date: Date, sequence: number): string {
  return `${expenseReferencePrefixForDate(date)}-${String(sequence).padStart(EXPENSE_CONFIG.reference.sequenceLength, '0')}`;
}
