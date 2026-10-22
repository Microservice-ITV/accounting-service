import { z } from 'zod';

export const accountSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  parentCode: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export type AccountInputDto = z.infer<typeof accountSchema>;
