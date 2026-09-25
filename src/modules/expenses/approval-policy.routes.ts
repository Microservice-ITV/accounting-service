import { Router } from 'express';
import { z } from 'zod';
import { requireExpenseAuth } from '../../middleware/auth.js';
import {
  createApprovalPolicy,
  deleteApprovalPolicy,
  getApprovalPolicy,
  listApprovalPolicies,
  listPlatformApprovalPolicies,
  getPlatformApprovalPolicy,
  setPlatformApprovalPolicyActive,
  deletePlatformApprovalPolicy,
  listApprovalPolicyApproverOptions,
  setApprovalPolicyActive,
  updateApprovalPolicy,
} from './approval-policy.service.js';

const router = Router();

function getAuth(req: any) {
  return (req as { auth?: any }).auth ?? null;
}

function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }) {
  const value = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ')
    ? value.slice('Bearer '.length).trim()
    : '';
}

function getParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

const policySchema = z.object({
  scope: z.enum(['SHOP', 'PLATFORM']).default('SHOP'),
  shopId: z.string().trim().min(1).nullable().optional(),
  approverUserId: z.string().trim().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  minAmount: z.coerce.number().finite().nonnegative(),
  maxAmount: z.coerce.number().finite().nonnegative().nullable().optional(),
  level: z.coerce.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
}).superRefine((input, context) => {
  if (input.scope === 'SHOP' && !input.shopId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['shopId'], message: 'shopId is required for shop policies' });
  if (input.scope === 'PLATFORM' && input.shopId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['shopId'], message: 'Platform policies cannot specify a shop' });
});
const activeSchema = z.object({ isActive: z.boolean() });

router.get('/approval-policies/approver-options', requireExpenseAuth, async (req, res) => {
  try {
    const shopId = z.string().trim().min(1).parse(req.query.shopId);
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    return res.json(await listApprovalPolicyApproverOptions(shopId, getAuth(req), token));
  } catch (error) {
    const message = error instanceof z.ZodError ? 'shopId is required' : error instanceof Error ? error.message : 'Failed to load approver options';
    return res.status(/Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 403 : 400).json({ error: message });
  }
});

router.get('/approval-policies', requireExpenseAuth, async (req, res) => {
  try {
    if (req.query.scope === 'PLATFORM') {
      return res.json({ policies: await listPlatformApprovalPolicies(getAuth(req)) });
    }
    const shopId = z.string().trim().min(1).parse(req.query.shopId);
    return res.json({ policies: await listApprovalPolicies(shopId, getAuth(req)) });
  } catch (error) {
    const message = error instanceof z.ZodError ? 'shopId is required' : error instanceof Error ? error.message : 'Failed to load approval policies';
    return res.status(/Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 403 : 400).json({ error: message });
  }
});

router.get('/approval-policies/:id', requireExpenseAuth, async (req, res) => {
  try {
    if (req.query.scope === 'PLATFORM') {
      return res.json(await getPlatformApprovalPolicy(getParam(req.params.id), getAuth(req)));
    }
    const shopId = z.string().trim().min(1).parse(req.query.shopId);
    return res.json(await getApprovalPolicy(getParam(req.params.id), shopId, getAuth(req)));
  } catch (error) {
    const message = error instanceof z.ZodError ? 'shopId is required' : error instanceof Error ? error.message : 'Failed to load approval policy';
    return res.status(/not found/i.test(message) ? 404 : /Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 403 : 400).json({ error: message });
  }
});

router.post('/approval-policies', requireExpenseAuth, async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const input = policySchema.parse(req.body);
    return res.status(201).json(await createApprovalPolicy({ ...input, shopId: input.shopId ?? '' }, getAuth(req), token));
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid policy payload' : error instanceof Error ? error.message : 'Failed to create approval policy';
    return res.status(/overlaps|must be|approver|At least|Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 400 : 500).json({ error: message });
  }
});

router.patch('/approval-policies/:id', requireExpenseAuth, async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const input = policySchema.parse(req.body);
    return res.json(await updateApprovalPolicy(getParam(req.params.id), { ...input, shopId: input.shopId ?? '' }, getAuth(req), token));
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid policy payload' : error instanceof Error ? error.message : 'Failed to update approval policy';
    return res.status(/not found/i.test(message) ? 404 : /overlaps|must be|approver|At least|Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 400 : 500).json({ error: message });
  }
});

router.patch('/approval-policies/:id/status', requireExpenseAuth, async (req, res) => {
  try {
    if (req.query.scope === 'PLATFORM') {
      const payload = activeSchema.parse(req.body);
      return res.json(await setPlatformApprovalPolicyActive(getParam(req.params.id), payload.isActive, getAuth(req)));
    }
    const shopId = z.string().trim().min(1).parse(req.query.shopId);
    const payload = activeSchema.parse(req.body);
    return res.json(await setApprovalPolicyActive(getParam(req.params.id), shopId, payload.isActive, getAuth(req)));
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid status payload' : error instanceof Error ? error.message : 'Failed to update approval policy status';
    return res.status(/not found/i.test(message) ? 404 : /overlaps|Only the Shop Owner|Unauthorized|Unauthenticated/.test(message) ? 400 : 500).json({ error: message });
  }
});

router.delete('/approval-policies/:id', requireExpenseAuth, async (req, res) => {
  try {
    if (req.query.scope === 'PLATFORM') {
      await deletePlatformApprovalPolicy(getParam(req.params.id), getAuth(req));
      return res.status(204).send();
    }
    const shopId = z.string().trim().min(1).parse(req.query.shopId);
    await deleteApprovalPolicy(getParam(req.params.id), shopId, getAuth(req));
    return res.status(204).send();
  } catch (error) {
    const message = error instanceof z.ZodError ? 'shopId is required' : error instanceof Error ? error.message : 'Failed to delete approval policy';
    return res.status(/not found/i.test(message) ? 404 : /Only the Shop Owner|Unauthorized|Unauthenticated|Deactivate/.test(message) ? 400 : 500).json({ error: message });
  }
});

export default router;
