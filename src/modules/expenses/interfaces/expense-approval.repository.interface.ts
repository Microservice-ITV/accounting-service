import type { Prisma } from '@prisma/client';
import type {
  ApprovalActionRecord,
  ApprovalDbClient,
  ApprovalPolicyWithConditions,
  ApprovalRecord,
  CreateApprovalActionInput,
  CreateApprovalInput,
  ExpenseApprovalStatusRecord,
  ExpenseApprovalWithExpense,
  ExpenseApprovalWithExpenseType,
  ExpenseForApprovalSubmission,
  JournalReferenceRecord,
  UpdateApprovalInput,
  UpdateExpenseInput,
} from '../dto/expense-approval.dto.js';

export interface IExpenseApprovalRepository {
  findExpenseForSubmission(expenseId: string, client?: ApprovalDbClient): Promise<ExpenseForApprovalSubmission | null>;
  findActiveApprovalPolicies(client?: ApprovalDbClient): Promise<ApprovalPolicyWithConditions[]>;
  findExpenseApprovalStatus(expenseId: string, client?: ApprovalDbClient): Promise<ExpenseApprovalStatusRecord | null>;
  findPendingApprovalsForUser(userId: string, client?: ApprovalDbClient): Promise<ExpenseApprovalWithExpense[]>;

  lockExpense(expenseId: string, client: Prisma.TransactionClient): Promise<void>;
  lockApproval(approvalId: string, client: Prisma.TransactionClient): Promise<void>;

  findExpenseInTransaction(expenseId: string, client: Prisma.TransactionClient): Promise<Prisma.ExpenseGetPayload<{}> | null>;
  findApprovalsByExpenseId(expenseId: string, client: Prisma.TransactionClient): Promise<ApprovalRecord[]>;
  findReturnedApproval(expenseId: string, client: Prisma.TransactionClient): Promise<Pick<ApprovalRecord, 'id'> | null>;
  deleteApprovalsByExpenseId(expenseId: string, client: Prisma.TransactionClient): Promise<{ count: number }>;
  createApproval(input: CreateApprovalInput, client: Prisma.TransactionClient): Promise<ApprovalRecord>;
  createApprovalAction(input: CreateApprovalActionInput, client: Prisma.TransactionClient): Promise<ApprovalActionRecord>;
  updateApproval(approvalId: string, input: UpdateApprovalInput, client: Prisma.TransactionClient): Promise<ApprovalRecord>;
  findApprovalForApproval(approvalId: string, client: Prisma.TransactionClient): Promise<ExpenseApprovalWithExpenseType | null>;
  findApprovalForDecision(approvalId: string, client: Prisma.TransactionClient): Promise<ExpenseApprovalWithExpense | null>;
  findNextApproval(expenseId: string, stepNo: number, client: Prisma.TransactionClient): Promise<ApprovalRecord | null>;
  updateExpense(expenseId: string, input: UpdateExpenseInput, client: Prisma.TransactionClient): Promise<Prisma.ExpenseGetPayload<{}>>;
  findJournalByReference(referenceType: string, referenceId: string, client: Prisma.TransactionClient): Promise<JournalReferenceRecord | null>;
}