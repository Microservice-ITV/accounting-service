import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import { DeliveryCompanyFeeApplicationError } from '../errors/delivery-company-fee.error.js';

export class DeliveryCompanyFeeAuthorizationPolicy {
  requireShopAccess(
    authContext: AuthenticatedExpenseContext | null | undefined,
    shopId: string,
  ): void {
    if (!authContext?.userId) {
      throw new DeliveryCompanyFeeApplicationError('Unauthenticated', 401);
    }

    const authorizedShopIds = new Set(
      (authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean),
    );
    if (!authorizedShopIds.has(shopId)) {
      throw new DeliveryCompanyFeeApplicationError('User is not authorized for the selected shop', 403);
    }
  }

  requireShopAssignment(authContext: AuthenticatedExpenseContext): string[] {
    const shopIds = [...new Set(
      (authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean),
    )];
    if (shopIds.length === 0) {
      throw new DeliveryCompanyFeeApplicationError('Seller is not assigned to any authorized shop', 403);
    }
    return shopIds;
  }
}
