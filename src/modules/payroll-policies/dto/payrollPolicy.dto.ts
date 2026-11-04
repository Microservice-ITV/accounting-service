import { z } from 'zod';

export type PayrollPolicyInput = {
  shopId?: string | null;
  name: string;
  currency?: string;
  standardWorkingDays?: number;
  standardDailyHours?: number;
  overtimeRateMultiplier?: number;
  taxRate?: number;
  latenessDeductionPerMin?: number;
  absenceDeductionPerDay?: number;
  unpaidLeaveDeductionPerDay?: number;
  isActive?: boolean;
  effectiveFrom?: string | Date | null;
  effectiveTo?: string | Date | null;
};

export type PayrollPolicyFilters = {
  shopId?: string;
  isActive?: boolean;
  page?: number;
  perPage?: number;
};

export const policyBodySchema = z.object({
  shop_id: z.string().trim().nullable().optional(),
  name: z.string().trim().min(1),
  currency: z.string().trim().min(1).optional(),
  standard_working_days: z.coerce.number().int().positive().optional(),
  standard_daily_hours: z.coerce.number().positive().optional(),
  overtime_rate_multiplier: z.coerce.number().min(0).optional(),
  tax_rate: z.coerce.number().min(0).max(1).optional(),
  lateness_deduction_per_minute: z.coerce.number().min(0).optional(),
  absence_deduction_per_day: z.coerce.number().min(0).optional(),
  unpaid_leave_deduction_per_day: z.coerce.number().min(0).optional(),
  is_active: z.boolean().optional(),
  effective_from: z.union([z.string().trim().min(1), z.null()]).optional(),
  effective_to: z.union([z.string().trim().min(1), z.null()]).optional(),
});

export type PolicyBody = z.infer<typeof policyBodySchema>;

export const policyUpdateSchema = policyBodySchema.partial();

const booleanQuery = z.preprocess((value) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
}, z.boolean().optional());

export const policyQuerySchema = z.object({
  shop_id: z.string().trim().optional(),
  is_active: booleanQuery,
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(500).default(20),
});

export const toPolicyInput = (
  body: Partial<PolicyBody>,
): Partial<PayrollPolicyInput> => ({
  shopId: body.shop_id,
  name: body.name,
  currency: body.currency,
  standardWorkingDays: body.standard_working_days,
  standardDailyHours: body.standard_daily_hours,
  overtimeRateMultiplier: body.overtime_rate_multiplier,
  taxRate: body.tax_rate,
  latenessDeductionPerMin: body.lateness_deduction_per_minute,
  absenceDeductionPerDay: body.absence_deduction_per_day,
  unpaidLeaveDeductionPerDay: body.unpaid_leave_deduction_per_day,
  isActive: body.is_active,
  effectiveFrom: body.effective_from,
  effectiveTo: body.effective_to,
});

export const compactPolicyInput = (
  input: Partial<PayrollPolicyInput>,
): Partial<PayrollPolicyInput> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<PayrollPolicyInput>;
