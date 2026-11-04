import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { requireExpenseAuth, type AuthenticatedExpenseContext } from '../../middleware/auth.js';
import { ProfitLossAuthorizationPolicy } from '../profit-loss/policies/profit-loss-authorization.policy.js';
import { InventoryValuationService, getInventoryMappingAccountTypes, type InventoryMappingKey } from './inventory-valuation.service.js';

const service = new InventoryValuationService();
const scopePolicy = new ProfitLossAuthorizationPolicy();
const validMappingKeys = new Set(Object.keys(getInventoryMappingAccountTypes()));
const mappingBody = z.object({ accountId: z.string().min(1) }).strict();
const replayBody = z.object({ limit: z.number().int().positive().max(500).optional() }).strict();
const historyPagination = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
}).strict();

function authContext(req: Request): AuthenticatedExpenseContext | undefined {
  return (req as Request & { auth?: AuthenticatedExpenseContext }).auth;
}

function hasPlatformPermission(context: AuthenticatedExpenseContext | undefined, permission: string): boolean {
  return context?.platformRoles?.some((role) =>
    role.scope === 'platform' && role.permissions.includes(permission),
  ) ?? false;
}

const requireFinanceRead: RequestHandler = (req, res, next) => {
  if (!hasPlatformPermission(authContext(req), 'finance.read')) {
    res.status(403).json({ error: 'Platform finance.read permission is required' });
    return;
  }
  next();
};

const requireFinanceMappingWrite: RequestHandler = (req, res, next) => {
  if (!hasPlatformPermission(authContext(req), 'finance.account-mapping.write')) {
    res.status(403).json({ error: 'Platform finance.account-mapping.write permission is required' });
    return;
  }
  next();
};

function readDate(value: unknown, name: string, res: Response): Date | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    res.status(400).json({ error: `${name} must be a single ISO date/time` });
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    res.status(400).json({ error: `${name} must be a valid ISO date/time` });
    return null;
  }
  return parsed;
}

export function createInventoryAccountingRouter(
  authMiddleware: RequestHandler = requireExpenseAuth,
  inventoryService: InventoryValuationService = service,
) {
  const router = Router();

  router.get('/inventory/account-mappings', authMiddleware, requireFinanceRead, async (_req, res) => {
    try {
      res.json({ mappings: await inventoryService.getAccountMappings() });
    } catch (error) {
      console.error('Unable to read inventory account mappings', error);
      res.status(500).json({ error: 'Unable to read inventory account mappings' });
    }
  });

  router.put('/inventory/account-mappings/:mappingKey', authMiddleware, requireFinanceMappingWrite, async (req, res) => {
    const mappingKey = Array.isArray(req.params.mappingKey) ? req.params.mappingKey[0] : req.params.mappingKey;
    if (!validMappingKeys.has(mappingKey)) {
      res.status(400).json({ error: 'Unsupported inventory account mapping key' });
      return;
    }
    const body = mappingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    try {
      const context = authContext(req);
      if (!context?.userId) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const mapping = await inventoryService.setAccountMapping(
        mappingKey as InventoryMappingKey,
        body.data.accountId,
        context.userId,
      );
      res.json({ mapping });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save inventory account mapping';
      const status = /existing active/.test(message) ? 400 : 500;
      res.status(status).json({ error: status === 400 ? message : 'Unable to save inventory account mapping' });
    }
  });

  router.post('/inventory/valuations/replay-blocked', authMiddleware, requireFinanceMappingWrite, async (req, res) => {
    const body = replayBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'limit must be an integer from 1 to 500' });
      return;
    }
    try {
      res.json(await inventoryService.replayBlocked(body.data.limit));
    } catch (error) {
      console.error('Unable to replay blocked inventory valuations', error);
      res.status(500).json({ error: 'Unable to replay blocked inventory valuations' });
    }
  });

  router.get('/reports/inventory-valuation', authMiddleware, async (req, res) => {
    const from = readDate(req.query.from, 'from', res);
    const to = readDate(req.query.to, 'to', res);
    if (from === null || to === null) return;
    if (from && to && from > to) {
      res.status(400).json({ error: 'from must not be later than to' });
      return;
    }
    const queryValue = (value: unknown, key: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.trim().length === 0) {
        res.status(400).json({ error: `${key} must be a non-empty single value` });
        return undefined;
      }
      return value.trim();
    };
    const requestedShopId = queryValue(req.query.shop_id, 'shop_id');
    const requestedShopIds = queryValue(req.query.shop_ids, 'shop_ids');
    const warehouseId = queryValue(req.query.warehouse_id, 'warehouse_id');
    const sku = queryValue(req.query.sku, 'sku');
    if (res.headersSent) return;
    if (requestedShopId && requestedShopIds) {
      res.status(400).json({ error: 'Use either shop_id or shop_ids, not both' });
      return;
    }
    const pagination = historyPagination.safeParse({
      page: req.query.page,
      page_size: req.query.page_size,
    });
    if (!pagination.success) {
      res.status(400).json({ error: 'page must be positive and page_size must be between 1 and 100' });
      return;
    }

    try {
      const scope = scopePolicy.resolveSellerShopScope(authContext(req));
      let shopIds = scope.shopIds;
      if (requestedShopId) {
        shopIds = scopePolicy.resolveRequestedShopScope(scope, requestedShopId).shopIds;
      } else if (requestedShopIds) {
        const requestedIds = [...new Set(requestedShopIds.split(',').map((id) => id.trim()).filter(Boolean))];
        if (requestedIds.length === 0) {
          res.status(400).json({ error: 'shop_ids must contain at least one shop ID' });
          return;
        }
        shopIds = requestedIds.flatMap((id) =>
          scopePolicy.resolveRequestedShopScope(scope, id).shopIds ?? [],
        );
      }
      const report = await inventoryService.getReport({
        shopIds,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(sku ? { sku } : {}),
        historyPage: pagination.data.page,
        historyPageSize: pagination.data.page_size,
      });
      res.json(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to generate inventory valuation report';
      const status = /Unauthenticated/i.test(message) ? 401 : /Forbidden|authorized|assigned/i.test(message) ? 403 : 500;
      res.status(status).json({ error: status === 500 ? 'Unable to generate inventory valuation report' : message });
    }
  });

  return router;
}

export default createInventoryAccountingRouter();
