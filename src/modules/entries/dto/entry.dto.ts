import { z } from 'zod';

export const createJournalEntrySchema = z.object({
  referenceType: z.string().min(1),
  referenceId: z.string().min(1),
  eventId: z.string().optional(),
  narration: z.string().optional(),
  entryDate: z.union([z.string(), z.date()]).optional(),
  lines: z.array(z.object({
    accountCode: z.string(),
    direction: z.enum(['DEBIT', 'CREDIT']),
    amount: z.number(),
    currency: z.string().optional(),
    shopId: z.string().optional(),
    memo: z.string().optional(),
  })),
});
