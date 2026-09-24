import { Router } from 'express';
import { requireExpenseAuth } from '../../middleware/auth.js';
import { ExpenseApprovalController } from './controllers/expense-approval.controller.js';
import { expenseApprovalService } from './expense-approval.service.js';

const router = Router();
const expenseApprovalController = new ExpenseApprovalController(expenseApprovalService);

router.post('/expenses/:expenseId/submit', requireExpenseAuth, expenseApprovalController.submit.bind(expenseApprovalController));
router.get('/expenses/:expenseId/approval-status', requireExpenseAuth, expenseApprovalController.approvalStatus.bind(expenseApprovalController));
router.get('/expenses/pending-approvals', requireExpenseAuth, expenseApprovalController.pendingApprovals.bind(expenseApprovalController));
router.post('/expenses/:expenseId/approvals/:approvalId/approve', requireExpenseAuth, expenseApprovalController.approve.bind(expenseApprovalController));
router.post('/expenses/:expenseId/approvals/:approvalId/reject', requireExpenseAuth, expenseApprovalController.reject.bind(expenseApprovalController));
router.post('/expenses/:expenseId/approvals/:approvalId/return', requireExpenseAuth, expenseApprovalController.returnExpense.bind(expenseApprovalController));

export default router;
