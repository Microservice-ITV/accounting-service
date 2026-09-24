import type { Prisma } from '@prisma/client';
import { z } from 'zod';

export const submitExpenseSchema = z.object({
  actorUserId: z.string().trim().min(1).optional(),
  comment: z.string().trim().max(500).optional(),
});

export type ApprovalDbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

export type ExpenseForApprovalSubmission = Prisma.ExpenseGetPayload<{
  include: { expenseType: true };
}>;

export type ExpenseApprovalStatusRecord = Prisma.ExpenseGetPayload<{
  include: { approvals: { orderBy: { stepNo: 'asc' } } };
}>;

export type ExpenseApprovalWithExpense = Prisma.ExpenseApprovalGetPayload<{
  include: { expense: true };
}>;

export type ExpenseApprovalWithExpenseType = Prisma.ExpenseApprovalGetPayload<{
  include: { expense: { include: { expenseType: true } } };
}>;

export type ApprovalPolicyWithConditions = Prisma.ApprovalPolicyGetPayload<{
  include: { conditions: true };
}>;

export type ApprovalRecord = Prisma.ExpenseApprovalGetPayload<{}>;
export type ApprovalActionRecord = Prisma.ExpenseApprovalActionGetPayload<{}>;
export type ApprovalSummary = Pick<ApprovalRecord, 'id' | 'stepNo' | 'approverUserId' | 'status'>;
export type JournalReferenceRecord = Prisma.JournalEntryGetPayload<{
  select: { id: true };
}>;

export type ApprovalTransaction = <T>(
  callback: (client: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

export type ApprovalSubmissionResult = {
  expenseId: string;
  status: string;
  approvals: ApprovalSummary[];
  policyId: string;
};

export type ApprovalActionResult = {
  expenseId: string;
  approvalId: string;
  status: string;
  expenseStatus: string;
  currentApproval: ApprovalRecord;
  nextApproval?: ApprovalRecord | null;
};

export type CreateApprovalInput = Prisma.ExpenseApprovalUncheckedCreateInput;
export type CreateApprovalActionInput = Prisma.ExpenseApprovalActionUncheckedCreateInput;
export type UpdateApprovalInput = Prisma.ExpenseApprovalUncheckedUpdateInput;
export type UpdateExpenseInput = Prisma.ExpenseUncheckedUpdateInput;