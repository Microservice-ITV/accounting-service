import { ExpenseAuthorizationPolicy } from '../../expenses/policies/expense-authorization.policy.js';
import { ProfitLossApplicationError } from '../errors/profit-loss.error.js';
import type { AuthenticatedReportContext, ReportScope } from '../profit-loss.types.js';

const normalizeShopId = (value?: string | null) => String(value ?? '').trim();

export class ProfitLossAuthorizationPolicy {
  constructor(
    private readonly expenseAuthorizationPolicy = new ExpenseAuthorizationPolicy(),
  ) {}

  resolveSellerShopScope(context?: AuthenticatedReportContext | null): ReportScope {
    if (!context) {
      throw new ProfitLossApplicationError('Unauthenticated', 401);
    }

    if (this.expenseAuthorizationPolicy.canAccessPlatformExpenses(context)) {
      return { shopIds: null };
    }

    const shopIds = new Set(
      Array.from(context.authorizedShopIds ?? [])
        .map((shopId) => normalizeShopId(shopId))
        .filter(Boolean),
    );
    const activeShopId = normalizeShopId(context.activeShopId);
    if (activeShopId) shopIds.add(activeShopId);

    if (shopIds.size === 0) {
      throw new ProfitLossApplicationError('Seller must be assigned to an authorized shop', 403);
    }
    return { shopIds: [...shopIds] };
  }

  resolveRequestedShopScope(scope: ReportScope, requestedShopId?: string | null): ReportScope {
    const shopId = normalizeShopId(requestedShopId);
    if (!shopId) return scope;
    if (scope.shopIds && !scope.shopIds.includes(shopId)) {
      throw new ProfitLossApplicationError('Forbidden: shop is not assigned to this user', 403);
    }
    return { shopIds: [shopId] };
  }
}
