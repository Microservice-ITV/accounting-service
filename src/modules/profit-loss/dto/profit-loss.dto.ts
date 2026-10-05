import { z } from 'zod';
import type { ProfitLossQuery } from '../profit-loss.types.js';

const dateQueryParam = (parameter: string) => z.unknown().optional().transform((value, context) => {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid ${parameter} date` });
    return z.NEVER;
  }
  return date;
});

export const profitLossQuerySchema = z.object({
  from: dateQueryParam('from'),
  to: dateQueryParam('to'),
  groupBy: z.unknown()
    .transform((value) => typeof value === 'string' ? value : 'month')
    .pipe(z.enum(['day', 'month'], {
      errorMap: () => ({ message: 'groupBy must be day or month' }),
    })),
  shopId: z.unknown().transform((value) => typeof value === 'string' ? value : undefined),
}).superRefine((query, context) => {
  if (query.from && query.to && query.from >= query.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from must be earlier than to' });
  }
}).transform((query): ProfitLossQuery => ({
  from: query.from,
  to: query.to,
  groupBy: query.groupBy,
  requestedShopId: query.shopId,
}));
