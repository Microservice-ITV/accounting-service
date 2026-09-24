import { Prisma } from '@prisma/client';

import type { IExpenseRepository } from '../interfaces/expense.repository.interface.js';
import type { IExpenseService } from '../interfaces/expense.service.interface.js';
import type { CreateExpenseInput, ExpenseAuthContext, ExpenseCategoryInput } from '../dto/expense.dto.js';

const validateReceiptImage = (receiptImage?: string) => {
  if (!receiptImage) return undefined;
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(receiptImage)) throw new Error('Receipt must be a JPEG, PNG, or WebP image');
  if (receiptImage.length > 7_000_000) throw new Error('Receipt image must be 5 MB or smaller');
  return receiptImage;
};

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function buildExpenseReferenceId(date: Date, sequence: number) {
  return `EXP-${formatDateKey(new Date(date))}-${String(sequence).padStart(4, '0')}`;
}

function isExpenseReferenceCollision(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes('expenseNo');
}

export class ExpenseService implements IExpenseService {
  constructor(private readonly expenseRepository: IExpenseRepository) {}

  listExpenseCategories() { return this.expenseRepository.listExpenseCategories(); }

  createExpenseCategory(input: ExpenseCategoryInput) {
    return this.expenseRepository.createExpenseCategory({ code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() || null, status: input.status?.trim() || 'ACTIVE' });
  }

  updateExpenseCategory(id: string, input: ExpenseCategoryInput) {
    return this.expenseRepository.updateExpenseCategory(id, { code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() || null, status: input.status?.trim() || 'ACTIVE' });
  }

  deleteExpenseCategory(id: string) { return this.expenseRepository.deleteExpenseCategory(id); }

  async createExpense(input: CreateExpenseInput, authContext?: ExpenseAuthContext | null) {
    if (!authContext) throw new Error('Unauthenticated');
    if (!authContext.userId) throw new Error('Authenticated user is required');
    const shopId = input.shopId?.trim();
    if (!shopId) throw new Error('Shop is required for the expense');
    const authorizedShopIds = new Set(Array.from(authContext.authorizedShopIds ?? []).map((id) => id.trim()).filter(Boolean));
    if (authorizedShopIds.size > 0 && !authorizedShopIds.has(shopId)) throw new Error('User is not authorized for the selected shop');
    const activeShopId = authContext.activeShopId?.trim() || Array.from(authorizedShopIds)[0];
    if (!activeShopId) throw new Error('Seller is not assigned to any authorized shop');
    const expenseAccountCode = input.expenseAccountCode || '5000';
    const fundingAccountCode = input.fundingAccountCode || '1000';
    const description = input.description?.trim();
    const receiptImage = validateReceiptImage(input.receiptImage);
    const categoryId = input.expenseCategoryId?.trim() || input.category?.trim();
    const expenseDate = input.expenseDate ? new Date(input.expenseDate) : new Date();
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Expense amount must be greater than 0');
    if (!categoryId) throw new Error('Expense category is required');
    const expenseCategory = await this.expenseRepository.findCategory(categoryId);
    if (!expenseCategory || expenseCategory.status !== 'ACTIVE') throw new Error('Unknown or inactive expense category');
    if (expenseAccountCode === fundingAccountCode) throw new Error('Expense and funding accounts must be different');
    const accounts = await this.expenseRepository.findAccountsByCodes([expenseAccountCode, fundingAccountCode]);
    const accountMap = new Map(accounts.map((account) => [account.code, account]));
    const expenseAccount = accountMap.get(expenseAccountCode);
    const fundingAccount = accountMap.get(fundingAccountCode);
    if (!expenseAccount || !fundingAccount) {
      const missingCodes = [expenseAccountCode, fundingAccountCode].filter((code) => !accountMap.has(code));
      throw new Error(`Unknown account codes: ${missingCodes.join(', ')}`);
    }
    if (expenseAccount.type !== 'EXPENSE') throw new Error(`Account ${expenseAccountCode} must be an EXPENSE account`);
    if (fundingAccount.type === 'INCOME' || fundingAccount.type === 'EXPENSE') throw new Error(`Account ${fundingAccountCode} cannot fund an expense`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const expenseEntries = await this.expenseRepository.findExpenseReferences(`EXP-${formatDateKey(expenseDate)}`);
      const nextSequence = expenseEntries.reduce((max, entry) => {
        const match = entry.referenceId.match(/-(\d{4})$/);
        return Math.max(max, match ? Number.parseInt(match[1], 10) : 0);
      }, 0) + 1;
      const referenceId = buildExpenseReferenceId(expenseDate, nextSequence);

      try {
        return await this.expenseRepository.transaction(async (tx) => ({
          expense: await this.expenseRepository.createExpense({ expenseNo: referenceId, shopId, sellerUserId: authContext.userId, expenseTypeId: expenseCategory.id, expenseAccountCode, fundingAccountCode, amount: input.amount, currency: 'MMK', description: description ?? null, receiptImage: receiptImage ?? null, expenseDate, status: 'DRAFT' }, tx),
          journalEntry: null,
        }));
      } catch (error) {
        if (isExpenseReferenceCollision(error)) continue;
        throw error;
      }
    }

    throw new Error('Unable to generate a unique expense reference. Please try again.');
  }

  async updateReturnedExpense(expenseId: string, input: Pick<CreateExpenseInput, 'amount' | 'expenseDate' | 'expenseCategoryId' | 'description' | 'receiptImage'>, authContext?: ExpenseAuthContext | null) {
    if (!authContext?.userId) throw new Error('Unauthenticated');
    const expense = await this.expenseRepository.findExpenseById(expenseId);
    if (!expense || expense.sellerUserId !== authContext.userId) throw new Error('Expense not found');
    if (expense.status !== 'RETURNED') throw new Error('Only returned expenses can be edited');
    if (!Number.isFinite(input.amount) || (input.amount ?? 0) <= 0) throw new Error('Expense amount must be greater than 0');
    const categoryId = input.expenseCategoryId?.trim();
    if (!categoryId) throw new Error('Expense category is required');
    const category = await this.expenseRepository.findCategory(categoryId);
    if (!category || category.status !== 'ACTIVE') throw new Error('Unknown or inactive expense category');
    const receiptImage = validateReceiptImage(input.receiptImage);
    const expenseDate = input.expenseDate ? new Date(input.expenseDate) : expense.expenseDate;
    if (Number.isNaN(expenseDate.getTime())) throw new Error('Invalid expense date');
    return this.expenseRepository.transaction((tx) => this.expenseRepository.updateReturnedExpense(expenseId, { amount: input.amount, expenseDate, expenseTypeId: category.id, description: input.description?.trim() || null, ...(receiptImage !== undefined ? { receiptImage } : {}), status: 'DRAFT', submittedAt: null }, tx));
  }

  async listExpenses(authContext?: ExpenseAuthContext | null) {
    if (!authContext || !authContext.authorizedShopIds) throw new Error('Unauthorized');
    const authorizedShopIds = Array.from(authContext.authorizedShopIds).map((shopId) => shopId.trim()).filter(Boolean);
    if (authorizedShopIds.length === 0) throw new Error('Unauthorized');
    return this.expenseRepository.listExpenses(authorizedShopIds);
  }

  async getExpenseByReference(referenceId: string, authContext?: ExpenseAuthContext | null) {
    const authorizedShopIds = Array.from(authContext?.authorizedShopIds ?? []).map((shopId) => shopId.trim()).filter(Boolean);
    if (authorizedShopIds.length === 0) throw new Error('Unauthorized');
    const expense = await this.expenseRepository.findExpenseByReference(referenceId, authorizedShopIds);
    if (!expense) return null;
    const journalEntry = await this.expenseRepository.findJournalByExpenseReference(expense.expenseNo);
    return { ...expense, journalEntry };
  }
}