import { Router } from 'express';
import { z } from 'zod';
import {
  approveExpenseStep,
  getExpenseApprovalStatus,
  getPendingApprovalsForUser,
  rejectExpenseStep,
  returnExpenseStep,
  submitExpenseForApproval,
} from './expense-approval.service.js';

const router = Router();

function getActorUserId(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const authHeader = req.headers.authorization;
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value || !value.startsWith('Bearer ')) {
    return undefined;
  }

  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

const submitExpenseSchema = z.object({
  actorUserId: z.string().trim().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
});

router.post('/expenses/:expenseId/submit', async (req, res) => {
  try {
    const expenseId = req.params.expenseId;
    const payload = submitExpenseSchema.parse(req.body ?? {});
    const actorUserId = payload.actorUserId || getActorUserId(req);

    const result = await submitExpenseForApproval(expenseId, actorUserId);
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to submit expense';
    return res.status(400).json({ error: message });
  }
});

router.get('/expenses/:expenseId/approval-status', async (req, res) => {
  try {
    const status = await getExpenseApprovalStatus(req.params.expenseId);
    return res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch approval status';
    return res.status(404).json({ error: message });
  }
});

router.get('/expenses/pending-approvals', async (req, res) => {
  try {
    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const approvals = await getPendingApprovalsForUser(actorUserId);
    return res.json({ approvals });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch pending approvals';
    return res.status(500).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/approve', async (req, res) => {
  try {
    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await approveExpenseStep(req.params.expenseId, req.params.approvalId, actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Approval failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/reject', async (req, res) => {
  try {
    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await rejectExpenseStep(req.params.expenseId, req.params.approvalId, actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Rejection failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

router.post('/expenses/:expenseId/approvals/:approvalId/return', async (req, res) => {
  try {
    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await returnExpenseStep(req.params.expenseId, req.params.approvalId, actorUserId, req.body?.comment);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Return action failed';
    const status = message.includes('Forbidden') ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

export default router;
