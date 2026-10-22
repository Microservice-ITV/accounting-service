import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ExpenseAuthorizationPolicy } from '../modules/expenses/policies/expense-authorization.policy.js';

type AuthenticatedPlatformRole = {
  code: string;
  name?: string;
  scope: string;
  permissions: string[];
};

export type AuthenticatedExpenseContext = {
  userId: string;
  email?: string;
  role?: string;
  platformRoles?: AuthenticatedPlatformRole[];
  activeShopId?: string | null;
  authorizedShopIds: string[];
  shops: Array<{ shop_id?: string | null; shop_name?: string | null; shop_domain?: string | null; membership_status?: string | null; role?: { code?: string | null; name?: string | null } | null }>;
};

const expenseAuthorizationPolicy = new ExpenseAuthorizationPolicy();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePlatformRoles(value: unknown): AuthenticatedPlatformRole[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate): AuthenticatedPlatformRole[] => {
    if (!isRecord(candidate)
      || typeof candidate.code !== 'string'
      || typeof candidate.scope !== 'string'
      || !Array.isArray(candidate.permissions)
      || !candidate.permissions.every((permission) => typeof permission === 'string')) {
      return [];
    }

    return [{
      code: candidate.code,
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      scope: candidate.scope,
      permissions: candidate.permissions,
    }];
  });
}

function getBearerToken(headerValue: string | string[] | undefined): string | undefined {
  if (Array.isArray(headerValue)) {
    return headerValue.find((value) => typeof value === 'string' && value.startsWith('Bearer '))?.slice('Bearer '.length).trim();
  }

  if (typeof headerValue === 'string' && headerValue.startsWith('Bearer ')) {
    return headerValue.slice('Bearer '.length).trim();
  }

  return undefined;
}

function normalizeAuthContext(raw: any): AuthenticatedExpenseContext | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const user = raw.user ?? raw.data?.user ?? raw.data ?? raw;
  const accessContext = raw.access_context ?? raw.data?.access_context ?? raw;

  const userId =
    typeof user?.id === 'string' ? user.id :
    typeof user?.user_id === 'string' ? user.user_id :
    typeof user?.sub === 'string' ? user.sub :
    typeof user?.userId === 'string' ? user.userId :
    undefined;

  if (!userId) {
    return null;
  }

  const shops = Array.isArray(accessContext?.shops) ? accessContext.shops : [];
  const platformRoles = normalizePlatformRoles(accessContext?.platform_roles);
  const activeShop = accessContext?.active_shop ?? null;
  const platformRole = platformRoles.find((role: { code?: unknown }) => typeof role?.code === 'string')?.code;
  const userRole = typeof user?.role === 'string'
    ? user.role
    : typeof user?.role?.code === 'string'
      ? user.role.code
      : undefined;

  const authorizedShopIds = shops
    .map((shop: { shop_id?: string | null }) => typeof shop?.shop_id === 'string' ? shop.shop_id.trim() : '')
    .filter((shopId: string) => shopId.length > 0);

  const activeShopId =
    typeof activeShop?.shop_id === 'string' ? activeShop.shop_id.trim() || undefined :
    typeof raw?.active_shop_id === 'string' ? raw.active_shop_id.trim() || undefined :
    undefined;

  return {
    userId,
    email: typeof user?.email === 'string' ? user.email : undefined,
    role: platformRole ?? userRole,
    platformRoles,
    activeShopId,
    authorizedShopIds: Array.from(new Set(authorizedShopIds)),
    shops,
  };
}

export async function resolveAuthenticatedExpenseContext(req: Request): Promise<AuthenticatedExpenseContext> {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    throw new Error('Unauthenticated');
  }

  const authBaseUrl = (process.env.AUTH_SERVICE_BASE_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
  const response = await fetch(`${authBaseUrl}/me/access-context`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Unauthorized');
  }

  const payload = await response.json().catch(() => null);
  const context = normalizeAuthContext(payload);

  if (!context) {
    throw new Error('Unauthenticated');
  }

  const isPlatformUser = expenseAuthorizationPolicy.canAccessPlatformExpenses(context);

  if (!context.activeShopId && context.authorizedShopIds.length === 0 && !isPlatformUser) {
    throw new Error('Seller is not assigned to any authorized shop');
  }

  return context;
}

export function requireExpenseAuth(req: Request, _res: Response, next: NextFunction) {
  void (async () => {
    try {
      const context = await resolveAuthenticatedExpenseContext(req);
      (req as Request & { auth?: AuthenticatedExpenseContext }).auth = context;
      (req as Request & { user?: { id?: string; userId?: string; activeShopId?: string | null } }).user = {
        id: context.userId,
        userId: context.userId,
        activeShopId: context.activeShopId ?? null,
      };
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unauthorized';
      const status = /unauthenticated|unauthorized|token/i.test(message) ? 401 : 403;
      const response = _res as Response & { statusCode?: number };
      response.status(status).json({ error: message });
    }
  })();
}

function hasValidOrderServiceKey(req: Request): boolean {
  const expected = process.env.ORDER_SERVICE_API_KEY;
  const provided = req.header('x-service-key');
  if (!expected || !provided) return false;

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function requireDeliveryCompanyConfigurationAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (hasValidOrderServiceKey(req)) {
    return next();
  }

  void (async () => {
    try {
      const context = await resolveAuthenticatedExpenseContext(req);
      const shopId = Array.isArray(req.params.shopId) ? req.params.shopId[0] : req.params.shopId;
      const isPlatformUser = expenseAuthorizationPolicy.canAccessPlatformExpenses(context);
      const canAccessShop = context.activeShopId === shopId
        || context.authorizedShopIds.includes(shopId);

      if (!isPlatformUser && !canAccessShop) {
        return res.status(403).json({ error: 'User is not authorized for the selected shop' });
      }

      (req as Request & { auth?: AuthenticatedExpenseContext }).auth = context;
      return next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unauthorized';
      const status = /unauthenticated|unauthorized|token/i.test(message) ? 401 : 403;
      return res.status(status).json({ error: message });
    }
  })();
}
