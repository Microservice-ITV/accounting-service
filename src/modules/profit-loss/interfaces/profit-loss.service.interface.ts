import type {
  AuthenticatedReportContext,
  ProfitLossQuery,
  ProfitLossResponse,
} from '../profit-loss.types.js';

export interface IProfitLossService {
  getProfitLoss(
    query: ProfitLossQuery,
    context: AuthenticatedReportContext,
  ): Promise<ProfitLossResponse>;
}
