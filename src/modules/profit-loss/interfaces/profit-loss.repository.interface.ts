import type {
  ProfitLossQueryData,
  ScopedProfitLossQuery,
} from '../profit-loss.types.js';

export interface IProfitLossRepository {
  getProfitLossData(
    query: ScopedProfitLossQuery,
  ): Promise<ProfitLossQueryData>;
}
