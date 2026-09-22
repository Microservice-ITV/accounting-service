import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireExpenseAuth, type AuthenticatedExpenseContext } from '../../middleware/auth.js';
import {
  approveExpenseStep,
  getExpenseApprovalStatus,
  getPendingApprovalsForUser,
  rejectExpenseStep,
  returnExpenseStep,
  submitExpenseForApproval,
} from './expense-approval.service.js';

const router = Router();

function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const authHeader = req.headers.authorization;
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value || !value.startsWith('Bearer ')) {
    return undefined;
  }

  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

function getAuthenticatedUserId(req: Request & { auth?: AuthenticatedExpenseContext }): string {
  const userId = req.auth?.userId;
  if (!userId) {
    throw new Error('Unauthorized');
  }
  return userId;
}

function getParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

const submitExpenseSchema = z.object({
  actorUserId: z.string().trim().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
});

router.post('/expenses/:expenseId/submit', requireExpenseAuth, async (req, res) => {
  try {
    const expenseId = getParam(req.params.expenseId);
    const payload = submitExpenseSchema.parse(req.body ?? {});
    const actorUserId = getAuthenticatedUserId(req);

    const result = await submitExpenseForApproval(expenseId, actorUserId, getBearerToken(req));
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to submit expense';
    return res.status(400).json({ error: message });
  }
});

router.get('/expenses/:expenseId/approval-status', requireExpenseAuth, async (req, res) => {
  try {
    const auth = (req as Request & { auth?: AuthenticatedExpenseContext }).auth;
    const status = await getExpenseApprovalStatus(getParam(req.params.expenseId), auth?.authorizedShopIds ?? []);
    return res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch approval status';
    const status = message.includes('Forbidden') ? 403 : message === 'Expense not found' ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

router.get('/expenses/pending-approvals', requireExpenseAuth, async (req, res) => {
  try {
    const approvals = await getPendingApprovalsForUser(getAuthenticatedUserId(req));
    return res.json({ approvals });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch pending approvals';
    return res.status(500).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/approve', requireExpenseAuth, async (req, res) => {
  try {
    const actorUserId = getAuthenticatedUserId(req);
    const result = await approveExpenseStep(getParam(req.params.expenseId), getParam(req.params.approvalId), actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Approval failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/reject', requireExpenseAuth, async (req, res) => {
  try {
    const actorUserId = getAuthenticatedUserId(req);
    const result = await rejectExpenseStep(getParam(req.params.expenseId), getParam(req.params.approvalId), actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Rejection failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/return', requireExpenseAuth, async (req, res) => {
  try {
    const actorUserId = getAuthenticatedUserId(req);
    const result = await returnExpenseStep(getParam(req.params.expenseId), getParam(req.params.approvalId), actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Return action failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

export default router;
