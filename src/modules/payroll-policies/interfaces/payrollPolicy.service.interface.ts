import type {
  PayrollPolicyFilters,
  PayrollPolicyInput,
} from '../dto/payrollPolicy.dto.js';
import type { PayrollPolicyRecord } from './payrollPolicy.repository.interface.js';

export type PayrollPolicyListResult = {
  data: PayrollPolicyRecord[];
  meta: {
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
};

export interface IPayrollPolicyService {
  list(filters?: PayrollPolicyFilters): Promise<PayrollPolicyListResult>;
  getById(id: string): Promise<PayrollPolicyRecord | null>;
  getActiveForShop(shopId: string | null): Promise<PayrollPolicyRecord | null>;
  create(input: PayrollPolicyInput): Promise<PayrollPolicyRecord>;
  update(
    id: string,
    input: Partial<PayrollPolicyInput>,
  ): Promise<PayrollPolicyRecord | null>;
  delete(id: string): Promise<boolean>;
}
