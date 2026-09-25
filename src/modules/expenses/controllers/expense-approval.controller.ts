import type { Request, Response } from 'express';
import { requireExpenseAuth, type AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import { submitExpenseSchema } from '../dto/expense-approval.dto.js';
import type { IExpenseApprovalService } from '../interfaces/expense-approval.service.interface.js';

type ApprovalRequest = Request & { auth?: AuthenticatedExpenseContext };

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value || !value.startsWith('Bearer ')) {
    return undefined;
  }

  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

function getAuthenticatedUserId(req: ApprovalRequest): string {
  const userId = req.auth?.userId;
  if (!userId) {
    throw new Error('Unauthorized');
  }
  return userId;
}

export class ExpenseApprovalController {
  constructor(private readonly approvalService: IExpenseApprovalService) {}

  async submit(req: ApprovalRequest, res: Response) {
    try {
      const expenseId = getParam(req.params.expenseId);
      const payload = submitExpenseSchema.parse(req.body ?? {});
      void payload;
      const actorUserId = getAuthenticatedUserId(req);
      const result = await this.approvalService.submitExpenseForApproval(expenseId, actorUserId, getBearerToken(req));
      return res.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit expense';
      return res.status(400).json({ error: message });
    }
  }

  async approvalStatus(req: ApprovalRequest, res: Response) {
    try {
      const status = await this.approvalService.getExpenseApprovalStatus(
        getParam(req.params.expenseId),
        req.auth?.authorizedShopIds ?? [],
        ['platform_super_admin', 'super_admin', 'platform_finance', 'finance_manager', 'platform_director', 'cfo']
          .includes(req.auth?.role?.trim().toLowerCase() ?? ''),
      );
      return res.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch approval status';
      const status = message.includes('Forbidden') ? 403 : message === 'Expense not found' ? 404 : 500;
      return res.status(status).json({ error: message });
    }
  }

  async pendingApprovals(req: ApprovalRequest, res: Response) {
    try {
      const approvals = await this.approvalService.getPendingApprovalsForUser(getAuthenticatedUserId(req));
      return res.json({ approvals });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch pending approvals';
      return res.status(500).json({ error: message });
    }
  }

  async approve(req: ApprovalRequest, res: Response) {
    try {
      const actorUserId = getAuthenticatedUserId(req);
      const result = await this.approvalService.approveExpenseStep(
        getParam(req.params.expenseId),
        getParam(req.params.approvalId),
        actorUserId,
        req.body?.comment,
      );
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval failed';
      const status = message.includes('Forbidden') ? 403 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async reject(req: ApprovalRequest, res: Response) {
    try {
      const actorUserId = getAuthenticatedUserId(req);
      const result = await this.approvalService.rejectExpenseStep(
        getParam(req.params.expenseId),
        getParam(req.params.approvalId),
        actorUserId,
        req.body?.comment,
      );
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rejection failed';
      const status = message.includes('Forbidden') ? 403 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async returnExpense(req: ApprovalRequest, res: Response) {
    try {
      const actorUserId = getAuthenticatedUserId(req);
      const result = await this.approvalService.returnExpenseStep(
        getParam(req.params.expenseId),
        getParam(req.params.approvalId),
        actorUserId,
        req.body?.comment,
      );
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Return action failed';
      const status = message.includes('Forbidden') ? 403 : 400;
      return res.status(status).json({ error: message });
    }
  }
}

export { requireExpenseAuth };