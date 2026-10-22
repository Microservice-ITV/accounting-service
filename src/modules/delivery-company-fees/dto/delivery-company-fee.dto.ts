import { z } from 'zod';
import { DELIVERY_COMPANY_FEES_CONFIG } from '../../../config/delivery-company-fees.config.js';

export const deliveryCompanyFeeSchema = z.object({
  shopId: z.string().trim().min(1).max(64),
  deliveryCompanyId: z.string().trim().min(1),
  chargingBasis: z.enum(['PER_ORDER', 'PER_INVOICE']),
  amount: z.union([
    z.string().trim(),
    z.number().finite().transform(String),
  ]).pipe(
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Fee amount must have at most 2 decimal places'),
  ).refine((value) => Number(value) > 0 && Number(value) <= DELIVERY_COMPANY_FEES_CONFIG.maximumAmount, {
    message: `Fee amount must be greater than 0 and no more than ${DELIVERY_COMPANY_FEES_CONFIG.maximumAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  }),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code').transform((value) => value.toUpperCase()),
  active: z.boolean(),
  effectiveFrom: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  effectiveTo: z.string().datetime({ offset: true }).nullable().optional().transform((value) => value ? new Date(value) : null),
}).superRefine((input, context) => {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effectiveTo'],
      message: 'Effective To must be greater than or equal to Effective From',
    });
  }
});

export const deliveryCompanyFeeStatusSchema = z.object({ active: z.boolean() });

export type DeliveryCompanyFeeInput = z.infer<typeof deliveryCompanyFeeSchema>;
