import type { PayrollRunStatus } from '@prisma/client';
import { z } from 'zod';

export const PAYROLL_RUN_STATUSES = [
  'DRAFT',
  'CALCULATED',
  'UNDER_REVIEW',
  'APPROVED',
  'PAID',
  'VOID',
] as const;

export type PayrollRunInput = {
  reference?: string;
  periodStart: string | Date;
  periodEnd: string | Date;
  payDate?: string | Date | null;
  shopId?: string | null;
  payrollPolicyId?: string | null;
  currency?: string;
  notes?: string | null;
  status?: PayrollRunStatus;
};

export type PayrollRunFilters = {
  shopId?: string;
  status?: PayrollRunStatus;
  policyId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  perPage?: number;
};

export type PayrollActor = {
  actorId?: string;
  actorName?: string;
  comment?: string;
  reason?: string;
};

export const runBodySchema = z.object({
  reference: z.string().trim().optional(),
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
  pay_date: z.coerce.date().nullable().optional(),
  shop_id: z.string().trim().nullable().optional(),
  payroll_policy_id: z.string().trim().nullable().optional(),
  currency: z.string().trim().min(1).optional(),
  notes: z.string().trim().nullable().optional(),
  status: z.enum(PAYROLL_RUN_STATUSES).optional(),
});

export const runQuerySchema = z.object({
  shop_id: z.string().trim().optional(),
  status: z.enum(PAYROLL_RUN_STATUSES).optional(),
  policy_id: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(500).default(20),
});

export const toRunInput = (body: z.infer<typeof runBodySchema>): PayrollRunInput => ({
  reference: body.reference,
  periodStart: body.period_start,
  periodEnd: body.period_end,
  payDate: body.pay_date,
  shopId: body.shop_id,
  payrollPolicyId: body.payroll_policy_id,
  currency: body.currency,
  notes: body.notes,
  status: body.status,
});

export const readPayrollActor = (body: unknown): PayrollActor => {
  const payload = (body ?? {}) as PayrollActor;
  return {
    actorId: payload.actorId,
    actorName: payload.actorName,
    comment: payload.comment,
    reason: payload.reason,
  };
};
