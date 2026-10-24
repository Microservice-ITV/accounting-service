import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import type { DeliveryCompanyFee } from '@prisma/client';
import type { DeliveryCompanyFeeInput } from '../dto/delivery-company-fee.dto.js';

export interface IDeliveryCompanyFeeService {
  list(authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee[]>;
  get(id: string, authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee>;
  create(input: DeliveryCompanyFeeInput, authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee>;
  update(id: string, input: DeliveryCompanyFeeInput, authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee>;
  setActive(id: string, active: boolean, authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee>;
  listActiveConfigurations(shopId: string): Promise<Array<{ deliveryCompanyId: string | null }>>;
  isActiveConfiguration(shopId: string, deliveryCompanyId: string): Promise<boolean>;
}
