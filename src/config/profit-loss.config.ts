export const PROFIT_LOSS_CONFIG = {
  currencyFallback: 'UNKNOWN',
  missingComponents: ['refunds', 'tax', 'cogs', 'paymentFees', 'commission', 'shipping'],
  commissionStatus: 'temporarily disabled: platform commission rate is 0%',
} as const;
