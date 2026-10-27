import type { ExpenseAuthContext } from '../dto/expense.dto.js';
import { ExpenseApplicationError } from '../errors/expense.error.js';

const expenseReadPermission = 'finance.read';

export class ExpenseAuthorizationPolicy {
  canAccessPlatformExpenses(
    authContext?: Pick<ExpenseAuthContext, 'platformRoles'> | null,
  ): boolean {
    return authContext?.platformRoles?.some((role) =>
      role.scope === 'platform' && role.permissions?.includes(expenseReadPermission),
    ) ?? false;
  }

  requireAuthenticatedUser(authContext?: ExpenseAuthContext | null): ExpenseAuthContext & { userId: string } {
    if (authContext === undefined || authContext === null || !authContext.userId) {
      throw new ExpenseApplicationError('Unauthenticated', 401);
    }
    return authContext;
  }

  requirePlatformExpenseAccess(authContext?: ExpenseAuthContext | null): ExpenseAuthContext & { userId: string } {
    const authenticatedContext = this.requireAuthenticatedUser(authContext);
    if (!this.canAccessPlatformExpenses(authenticatedContext)) {
      throw new ExpenseApplicationError('User is not authorized to access platform expenses', 403);
    }
    return authenticatedContext;
  }

  requireAuthorizedShop(authContext: ExpenseAuthContext, requestedShopId: string): string[] {
    const authorizedShopIds = Array.from(authContext.authorizedShopIds ?? [])
      .map((shopId) => shopId.trim())
      .filter(Boolean);

    if (authorizedShopIds.length === 0 || !authorizedShopIds.includes(requestedShopId)) {
      throw new ExpenseApplicationError('User is not authorized for the selected shop', 403);
    }

    return authorizedShopIds;
  }

  getAuthorizedShopIds(authContext?: ExpenseAuthContext | null): string[] {
    const authenticatedContext = this.requireAuthenticatedUser(authContext);
    const authorizedShopIds = Array.from(authenticatedContext.authorizedShopIds ?? [])
      .map((shopId) => shopId.trim())
      .filter(Boolean);

    if (authorizedShopIds.length === 0) {
      throw new ExpenseApplicationError('User is not authorized for any shop', 403);
    }

    return authorizedShopIds;
  }
}
