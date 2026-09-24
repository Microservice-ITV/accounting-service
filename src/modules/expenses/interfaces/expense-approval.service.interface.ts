import type {
  ApprovalActionResult,
  ApprovalSubmissionResult,
  ExpenseApprovalStatusRecord,
  ExpenseApprovalWithExpense,
} from '../dto/expense-approval.dto.js';

export interface IExpenseApprovalService {
  getExpenseApprovalStatus(expenseId: string, authorizedShopIds?: readonly string[]): Promise<{
    expenseId: string;
    status: string;
    approvals: ExpenseApprovalStatusRecord['approvals'];
  }>;
  getPendingApprovalsForUser(userId: string): Promise<ExpenseApprovalWithExpense[]>;
  submitExpenseForApproval(expenseId: string, actorUserId?: string, bearerToken?: string): Promise<ApprovalSubmissionResult>;
  approveExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string): Promise<ApprovalActionResult>;
  rejectExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string): Promise<ApprovalActionResult>;
  returnExpenseStep(expenseId: string, approvalId: string, actorUserId: string, comment?: string): Promise<ApprovalActionResult>;
}