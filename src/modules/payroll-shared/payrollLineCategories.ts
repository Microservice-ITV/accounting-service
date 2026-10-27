import type { PayrollLineCategory, PayrollLineType } from '@prisma/client';

export const LINE_TYPE_OF_CATEGORY: Record<PayrollLineCategory, PayrollLineType> = {
  BASE_SALARY: 'EARNING',
  OVERTIME: 'EARNING',
  ALLOWANCE: 'EARNING',
  COMMISSION: 'EARNING',
  BONUS: 'EARNING',
  OTHER_EARNING: 'EARNING',
  UNPAID_LEAVE: 'DEDUCTION',
  ABSENCE: 'DEDUCTION',
  LATENESS: 'DEDUCTION',
  TAX: 'DEDUCTION',
  OTHER_DEDUCTION: 'DEDUCTION',
};

export const SYSTEM_CATEGORIES: PayrollLineCategory[] = [
  'BASE_SALARY',
  'OVERTIME',
  'UNPAID_LEAVE',
  'ABSENCE',
  'LATENESS',
  'TAX',
];
