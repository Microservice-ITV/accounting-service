import prisma from '../../lib/prisma.js';
import type { IExpenseApprovalService } from './interfaces/expense-approval.service.interface.js';
import { ExpenseApprovalRepository } from './repositories/expense-approval.repository.js';
import {
  ExpenseApprovalService,
  approvalPolicyMatchesExpense,
  advanceApprovalWorkflow,
  getMatchingApprovalPolicy,
  loadShopApproverMap,
  resolveManagerChain,
  buildSequentialManagerApprovals,
} from './services/expense-approval.service.js';

const approvalService = new ExpenseApprovalService(
  new ExpenseApprovalRepository(),
  (callback) => prisma.$transaction(callback),
);

export const expenseApprovalService: IExpenseApprovalService = approvalService;

export {
  ExpenseApprovalService,
  approvalPolicyMatchesExpense,
  advanceApprovalWorkflow,
  buildSequentialManagerApprovals,
  getMatchingApprovalPolicy,
  loadShopApproverMap,
  resolveManagerChain,
};

export type {
  ApprovalPolicySeed,
  ApprovalUserContext,
  ManagerChainApprovers,
} from './services/expense-approval.service.js';

export const getExpenseApprovalStatus = approvalService.getExpenseApprovalStatus.bind(approvalService);
export const getPendingApprovalsForUser = approvalService.getPendingApprovalsForUser.bind(approvalService);
export const submitExpenseForApproval = approvalService.submitExpenseForApproval.bind(approvalService);
export const approveExpenseStep = approvalService.approveExpenseStep.bind(approvalService);
export const rejectExpenseStep = approvalService.rejectExpenseStep.bind(approvalService);
export const returnExpenseStep = approvalService.returnExpenseStep.bind(approvalService);
