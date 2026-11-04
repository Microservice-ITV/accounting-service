import type {
  PaymentMethod,
  PaymentStatus,
  PayrollLineCategory,
  PayslipStatus,
} from '@prisma/client';
import { z } from 'zod';

export const PAYSLIP_STATUSES = ['GENERATED', 'ISSUED', 'REVOKED'] as const;
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'MOBILE_PAY'] as const;
export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'RECONCILED'] as const;
export const LINE_CATEGORIES = [
  'BASE_SALARY',
  'OVERTIME',
  'ALLOWANCE',
  'COMMISSION',
  'BONUS',
  'OTHER_EARNING',
  'UNPAID_LEAVE',
  'ABSENCE',
  'LATENESS',
  'TAX',
  'OTHER_DEDUCTION',
] as const;

export type AdjustmentInput = {
  category: PayrollLineCategory;
  description?: string | null;
  quantity?: number;
  rate?: number;
  amount?: number;
};

export type PaymentRecordInput = {
  payrollItemId?: string | null;
  employeeId?: string | null;
  method: PaymentMethod;
  status?: PaymentStatus;
  amount?: number;
  currency?: string;
  reference?: string | null;
  bankName?: string | null;
  accountLast4?: string | null;
  notes?: string | null;
};

export type BonusAwardSyncInput = {
  bonusAwardId: string;
  employeeId: string;
  employeeCode?: string;
  employeeName?: string;
  amount: number;
  description?: string;
  meta?: Record<string, unknown>;
};

export type PayslipFilters = {
  employeeId?: string;
  payrollRunId?: string;
  status?: PayslipStatus;
  page?: number;
  perPage?: number;
};

export type PaymentRecordFilters = {
  payrollRunId?: string;
  employeeId?: string;
  status?: PaymentStatus;
  method?: PaymentMethod;
  page?: number;
  perPage?: number;
};

const pageSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(500).default(20),
});

export const payslipQuerySchema = pageSchema.extend({
  employee_id: z.string().trim().optional(),
  payroll_run_id: z.string().trim().optional(),
  status: z.enum(PAYSLIP_STATUSES).optional(),
});

export const paymentQuerySchema = pageSchema.extend({
  payroll_run_id: z.string().trim().optional(),
  employee_id: z.string().trim().optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
});

export const itemQuerySchema = pageSchema;

export const adjustmentSchema = z.object({
  category: z.enum(LINE_CATEGORIES),
  description: z.string().trim().nullable().optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  amount: z.coerce.number().optional(),
});

export const paymentSchema = z.object({
  payroll_item_id: z.string().trim().nullable().optional(),
  employee_id: z.string().trim().nullable().optional(),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(PAYMENT_STATUSES).optional(),
  amount: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().min(1).optional(),
  reference: z.string().trim().nullable().optional(),
  bank_name: z.string().trim().nullable().optional(),
  account_last4: z.string().trim().max(4).nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

export const paymentStatusSchema = z.object({
  status: z.enum(PAYMENT_STATUSES),
});

export const bonusAwardSyncSchema = z.object({
  bonus_award_id: z.string().trim().min(1),
  employee_id: z.string().trim().min(1),
  employee_code: z.string().trim().optional(),
  employee_name: z.string().trim().optional(),
  amount: z.coerce.number().positive(),
  description: z.string().trim().optional(),
  meta: z.record(z.unknown()).optional(),
});

export const toAdjustmentInput = (
  body: z.infer<typeof adjustmentSchema>,
): AdjustmentInput => body;

export const toPaymentRecordInput = (
  body: z.infer<typeof paymentSchema>,
): PaymentRecordInput => ({
  payrollItemId: body.payroll_item_id,
  employeeId: body.employee_id,
  method: body.method,
  status: body.status,
  amount: body.amount,
  currency: body.currency,
  reference: body.reference,
  bankName: body.bank_name,
  accountLast4: body.account_last4,
  notes: body.notes,
});

export const toBonusAwardSyncInput = (
  body: z.infer<typeof bonusAwardSyncSchema>,
): BonusAwardSyncInput => ({
  bonusAwardId: body.bonus_award_id,
  employeeId: body.employee_id,
  employeeCode: body.employee_code,
  employeeName: body.employee_name,
  amount: body.amount,
  description: body.description,
  meta: body.meta,
});
