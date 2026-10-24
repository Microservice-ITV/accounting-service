export const EXPENSE_CONFIG = {
  defaults: {
    scope: 'SHOP',
    expenseAccountCode: '5000',
    fundingAccountCode: '1000',
    currency: 'MMK',
    categoryStatus: 'ACTIVE',
    expenseStatus: 'DRAFT',
  },
  categoryStatuses: ['ACTIVE', 'INACTIVE'],
  reference: {
    prefix: 'EXP',
    sequenceLength: 4,
    retryLimit: 10,
  },
  receipt: {
    maxSizeBytes: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
} as const;
