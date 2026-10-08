import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  requireDeliveryCompanyConfigurationAccess,
  requireExpenseAuth,
  type AuthenticatedExpenseContext,
} from '../../middleware/auth.js';
import {
  createDeliveryCompanyFee,
  getDeliveryCompanyFee,
  isActiveShopDeliveryCompanyConfiguration,
  listActiveShopDeliveryCompanyConfigurations,
  listDeliveryCompanyFees,
  setDeliveryCompanyFeeActive,
  updateDeliveryCompanyFee,
} from './delivery-company-fee.service.js';

const router = Router();

const feeRuleSchema = z.object({
  shopId: z.string().trim().min(1).max(64),
  deliveryCompanyId: z.string().trim().min(1),
  chargingBasis: z.enum(['PER_ORDER', 'PER_DAY']),
  amount: z.union([
    z.string().trim(),
    z.number().finite().transform(String),
  ]).pipe(
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Fee amount must have at most 2 decimal places'),
  ).refine((value) => Number(value) > 0 && Number(value) <= 99_999_999.99, {
    message: 'Fee amount must be greater than 0 and no more than 99,999,999.99',
  }),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code').transform((value) => value.toUpperCase()),
  active: z.boolean(),
  effectiveFrom: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  effectiveTo: z.string().datetime({ offset: true }).nullable().optional().transform((value) => value ? new Date(value) : null),
}).superRefine((input, context) => {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effectiveTo'],
      message: 'Effective To must be greater than or equal to Effective From',
    });
  }
});

const feeRuleStatusSchema = z.object({ active: z.boolean() });

function getAuth(req: Request): AuthenticatedExpenseContext {
  const auth = (req as Request & { auth?: AuthenticatedExpenseContext }).auth;
  if (!auth) throw new Error('Unauthenticated');
  return auth;
}

function getParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid Delivery Company fee rule' });
  }
  const message = error instanceof Error ? error.message : fallback;
  if (/Unauthenticated|Unauthorized/i.test(message)) return res.status(401).json({ error: message });
  if (/not authorized|cannot be changed|not assigned to any authorized shop/i.test(message)) return res.status(403).json({ error: message });
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  console.error('[DELIVERY_COMPANY_FEE_API_ERROR]', error);
  return res.status(500).json({ error: fallback });
}

router.get(
  '/delivery-company-configurations/shops/:shopId/active',
  requireDeliveryCompanyConfigurationAccess,
  async (req, res) => {
    try {
      const configurations = await listActiveShopDeliveryCompanyConfigurations(getParam(req.params.shopId));
      return res.json({ configurations });
    } catch (error) {
      return sendError(res, error, 'Unable to load active shop Delivery Companies');
    }
  },
);

router.get(
  '/delivery-company-configurations/shops/:shopId/checkout',
  async (req, res) => {
    try {
      const configurations = await listActiveShopDeliveryCompanyConfigurations(getParam(req.params.shopId));
      return res.json({ configurations });
    } catch (error) {
      return sendError(res, error, 'Unable to load active shop Delivery Companies');
    }
  },
);

router.get(
  '/delivery-company-configurations/shops/:shopId/companies/:deliveryCompanyId',
  requireDeliveryCompanyConfigurationAccess,
  async (req, res) => {
    try {
      const shopId = getParam(req.params.shopId);
      const deliveryCompanyId = getParam(req.params.deliveryCompanyId);
      const valid = await isActiveShopDeliveryCompanyConfiguration(shopId, deliveryCompanyId);
      if (!valid) return res.status(404).json({ error: 'Delivery Company is not configured and active for this shop' });
      return res.json({ shopId, deliveryCompanyId });
    } catch (error) {
      return sendError(res, error, 'Unable to validate shop Delivery Company');
    }
  },
);

router.get('/delivery-company-fees', requireExpenseAuth, async (req, res) => {
  try {
    const feeRules = await listDeliveryCompanyFees(getAuth(req));
    return res.json({ feeRules });
  } catch (error) {
    return sendError(res, error, 'Unable to load Delivery Company fee rules');
  }
});

router.get('/delivery-company-fees/:id', requireExpenseAuth, async (req, res) => {
  try {
    const feeRule = await getDeliveryCompanyFee(getParam(req.params.id), getAuth(req));
    return res.json({ feeRule });
  } catch (error) {
    return sendError(res, error, 'Unable to load Delivery Company fee rule');
  }
});

router.post('/delivery-company-fees', requireExpenseAuth, async (req, res) => {
  try {
    const input = feeRuleSchema.parse(req.body);
    const feeRule = await createDeliveryCompanyFee(input, getAuth(req));
    return res.status(201).json({ feeRule });
  } catch (error) {
    return sendError(res, error, 'Unable to create Delivery Company fee rule');
  }
});

router.patch('/delivery-company-fees/:id', requireExpenseAuth, async (req, res) => {
  try {
    const input = feeRuleSchema.parse(req.body);
    const feeRule = await updateDeliveryCompanyFee(getParam(req.params.id), input, getAuth(req));
    return res.json({ feeRule });
  } catch (error) {
    return sendError(res, error, 'Unable to update Delivery Company fee rule');
  }
});

router.patch('/delivery-company-fees/:id/status', requireExpenseAuth, async (req, res) => {
  try {
    const { active } = feeRuleStatusSchema.parse(req.body);
    const feeRule = await setDeliveryCompanyFeeActive(getParam(req.params.id), active, getAuth(req));
    return res.json({ feeRule });
  } catch (error) {
    return sendError(res, error, 'Unable to update Delivery Company fee rule status');
  }
});

export default router;
