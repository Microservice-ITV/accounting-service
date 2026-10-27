import { DeliveryCompanyFeeRepository } from './repositories/delivery-company-fee.repository.js';
import { DeliveryCompanyFeeService } from './services/delivery-company-fee.service.js';

export const deliveryCompanyFeeService = new DeliveryCompanyFeeService(
  new DeliveryCompanyFeeRepository(),
);
