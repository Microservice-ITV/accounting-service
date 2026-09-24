import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type {
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
import type { IExpenseApprovalRepository } from '../interfaces/expense-approval.repository.interface.js';

export class ExpenseApprovalRepository implements IExpenseApprovalRepository {
  findExpenseForSubmission(expenseId: string, client: ApprovalDbClient = prisma): Promise<ExpenseForApprovalSubmission | null> {
    return client.expense.findUnique({
      where: { id: expenseId },
      include: { expenseType: true },
    });
  }

  findActiveApprovalPolicies(client: ApprovalDbClient = prisma): Promise<ApprovalPolicyWithConditions[]> {
    return client.approvalPolicy.findMany({
      where: { isActive: true },
      include: { conditions: true },
      orderBy: [{ level: 'asc' }, { minAmount: 'asc' }],
    });
  }

  findExpenseApprovalStatus(expenseId: string, client: ApprovalDbClient = prisma): Promise<ExpenseApprovalStatusRecord | null> {
    return client.expense.findUnique({
      where: { id: expenseId },
      include: {
        approvals: {
          orderBy: { stepNo: 'asc' },
        },
      },
    });
  }

  findPendingApprovalsForUser(userId: string, client: ApprovalDbClient = prisma): Promise<ExpenseApprovalWithExpense[]> {
    return client.expenseApproval.findMany({
      where: {
        approverUserId: userId,
        status: 'PENDING',
      },
      include: {
        expense: true,
      },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  async lockExpense(expenseId: string, client: Prisma.TransactionClient): Promise<void> {
    await client.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;
  }

  async lockApproval(approvalId: string, client: Prisma.TransactionClient): Promise<void> {
    await client.$queryRaw`SELECT id FROM "ExpenseApproval" WHERE id = ${approvalId} FOR UPDATE`;
  }

  findExpenseInTransaction(expenseId: string, client: Prisma.TransactionClient): Promise<Prisma.ExpenseGetPayload<{}> | null> {
    return client.expense.findUnique({ where: { id: expenseId } });
  }

  findApprovalsByExpenseId(expenseId: string, client: Prisma.TransactionClient): Promise<ApprovalRecord[]> {
    return client.expenseApproval.findMany({
      where: { expenseId },
      orderBy: { stepNo: 'asc' },
    });
  }

  findReturnedApproval(expenseId: string, client: Prisma.TransactionClient): Promise<Pick<ApprovalRecord, 'id'> | null> {
    return client.expenseApproval.findFirst({
      where: { expenseId, action: 'RETURNED' },
      select: { id: true },
    });
  }

  deleteApprovalsByExpenseId(expenseId: string, client: Prisma.TransactionClient): Promise<{ count: number }> {
    return client.expenseApproval.deleteMany({ where: { expenseId } });
  }

  createApproval(input: CreateApprovalInput, client: Prisma.TransactionClient): Promise<ApprovalRecord> {
    return client.expenseApproval.create({ data: input });
  }

  createApprovalAction(input: CreateApprovalActionInput, client: Prisma.TransactionClient) {
    return client.expenseApprovalAction.create({ data: input });
  }

  updateApproval(approvalId: string, input: UpdateApprovalInput, client: Prisma.TransactionClient): Promise<ApprovalRecord> {
    return client.expenseApproval.update({ where: { id: approvalId }, data: input });
  }

  findApprovalForApproval(approvalId: string, client: Prisma.TransactionClient): Promise<ExpenseApprovalWithExpenseType | null> {
    return client.expenseApproval.findUnique({
      where: { id: approvalId },
      include: { expense: { include: { expenseType: true } } },
    });
  }

  findApprovalForDecision(approvalId: string, client: Prisma.TransactionClient): Promise<ExpenseApprovalWithExpense | null> {
    return client.expenseApproval.findUnique({
      where: { id: approvalId },
      include: { expense: true },
    });
  }

  findNextApproval(expenseId: string, stepNo: number, client: Prisma.TransactionClient): Promise<ApprovalRecord | null> {
    return client.expenseApproval.findFirst({
      where: {
        expenseId,
        stepNo: { gt: stepNo },
      },
      orderBy: { stepNo: 'asc' },
    });
  }

  updateExpense(expenseId: string, input: UpdateExpenseInput, client: Prisma.TransactionClient): Promise<Prisma.ExpenseGetPayload<{}>> {
    return client.expense.update({ where: { id: expenseId }, data: input });
  }

  findJournalByReference(referenceType: string, referenceId: string, client: Prisma.TransactionClient): Promise<JournalReferenceRecord | null> {
    return client.journalEntry.findUnique({
      where: {
        referenceType_referenceId: {
          referenceType,
          referenceId,
        },
      },
      select: { id: true },
    });
  }
}