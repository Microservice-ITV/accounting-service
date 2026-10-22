import { config } from './index.js';

export const DELIVERY_COMPANY_FEES_CONFIG = {
  maximumAmount: 99_999_999.99,
  shippingServiceBaseUrl: config.shippingServiceBaseUrl,
  shippingValidationTimeoutMs: 5_000,
} as const;
