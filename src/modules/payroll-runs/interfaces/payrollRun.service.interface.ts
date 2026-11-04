import type { PayrollRunFilters, PayrollRunInput } from '../dto/payrollRun.dto.js';
import type {
  PayrollRunRecord,
  PayrollRunWithDetails,
} from './payrollRun.repository.interface.js';

export type PayrollRunListResult = {
  data: PayrollRunRecord[];
  meta: {
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
};

export interface IPayrollRunService {
  list(filters?: PayrollRunFilters): Promise<PayrollRunListResult>;
  getById(id: string): Promise<PayrollRunWithDetails | null>;
  create(input: PayrollRunInput): Promise<PayrollRunWithDetails | null>;
  calculate(id: string, actorId?: string, actorName?: string): Promise<PayrollRunRecord>;
  submitForReview(id: string, actorId?: string, actorName?: string): Promise<PayrollRunRecord>;
  approve(
    id: string,
    actorId?: string,
    actorName?: string,
    comment?: string,
  ): Promise<PayrollRunRecord>;
  reject(
    id: string,
    actorId?: string,
    actorName?: string,
    comment?: string,
  ): Promise<PayrollRunRecord>;
  markPaid(id: string, actorId?: string, actorName?: string): Promise<PayrollRunRecord>;
  voidRun(
    id: string,
    actorId?: string,
    actorName?: string,
    reason?: string,
  ): Promise<PayrollRunRecord>;
}
