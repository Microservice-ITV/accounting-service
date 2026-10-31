import { Prisma } from '@prisma/client';
import { EXPENSE_CONFIG } from '../../../config/expense.config.js';
import { ExpenseApplicationError } from '../errors/expense.error.js';
import { parseExpenseDate, validateExpenseAmount } from '../helpers/expense-input.validator.js';
import { buildExpenseReferenceId, expenseReferencePrefixForDate } from '../helpers/expense-reference.generator.js';
import { validateReceiptImage } from '../helpers/receipt-validator.js';
import { ExpenseAuthorizationPolicy } from '../policies/expense-authorization.policy.js';
import type { IExpenseRepository } from '../interfaces/expense.repository.interface.js';
import type { IExpenseService } from '../interfaces/expense.service.interface.js';
import type { CreateExpenseInput, ExpenseAuthContext, ExpenseCategoryInput, ExpenseListStatus } from '../dto/expense.dto.js';

function isExpenseReferenceCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes('expenseNo')
    : target === 'expenseNo' || target === 'expenses_expenseNo_key';
}

function mapCategoryWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ExpenseApplicationError('An expense category with this code or name already exists', 409);
    }
    if (error.code === 'P2025') {
      throw new ExpenseApplicationError('Expense category not found', 404);
    }
  }

  throw error;
}

export class ExpenseService implements IExpenseService {
  constructor(
    private readonly expenseRepository: IExpenseRepository,
    private readonly authorizationPolicy = new ExpenseAuthorizationPolicy(),
  ) {}

  listExpenseCategories() {
    return this.expenseRepository.listExpenseCategories();
  }

  async createExpenseCategory(input: ExpenseCategoryInput) {
    try {
      return await this.expenseRepository.createExpenseCategory({
        code: input.code.trim(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        status: input.status?.trim() || EXPENSE_CONFIG.defaults.categoryStatus,
      });
    } catch (error) {
      mapCategoryWriteError(error);
    }
  }

  async updateExpenseCategory(id: string, input: ExpenseCategoryInput) {
    try {
      return await this.expenseRepository.updateExpenseCategory(id, {
        code: input.code.trim(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        status: input.status?.trim() || EXPENSE_CONFIG.defaults.categoryStatus,
      });
    } catch (error) {
      mapCategoryWriteError(error);
    }
  }

  async deleteExpenseCategory(id: string) {
    try {
      return await this.expenseRepository.deleteExpenseCategory(id);
    } catch (error) {
      mapCategoryWriteError(error);
    }
  }

  async createExpense(input: CreateExpenseInput, authContext?: ExpenseAuthContext | null) {
    const authenticatedContext = this.authorizationPolicy.requireAuthenticatedUser(authContext);
    const scope = input.scope ?? EXPENSE_CONFIG.defaults.scope;
    const shopId = input.shopId?.trim() ?? '';

    if (scope === 'PLATFORM') {
      if (shopId) {
        throw new ExpenseApplicationError('Platform expenses cannot specify a shop', 400);
      }
      this.authorizationPolicy.requirePlatformExpenseAccess(authenticatedContext);
    } else {
      if (!shopId) {
        throw new ExpenseApplicationError('Shop is required for a shop expense', 400);
      }
      this.authorizationPolicy.requireAuthorizedShop(authenticatedContext, shopId);
    }

    const expenseAccountCode = input.expenseAccountCode?.trim() || EXPENSE_CONFIG.defaults.expenseAccountCode;
    const fundingAccountCode = input.fundingAccountCode?.trim() || EXPENSE_CONFIG.defaults.fundingAccountCode;
    const description = input.description?.trim();
    const receiptImage = validateReceiptImage(input.receiptImage);
    const categoryId = input.expenseCategoryId?.trim() || input.category?.trim();
    const expenseDate = parseExpenseDate(input.expenseDate);
    validateExpenseAmount(input.amount);

    if (!categoryId) {
      throw new ExpenseApplicationError('Expense category is required', 400);
    }

    const expenseCategory = await this.expenseRepository.findCategory(categoryId);
    if (!expenseCategory || expenseCategory.status !== EXPENSE_CONFIG.defaults.categoryStatus) {
      throw new ExpenseApplicationError('Unknown or inactive expense category', 400);
    }
    if (expenseAccountCode === fundingAccountCode) {
      throw new ExpenseApplicationError('Expense and funding accounts must be different', 400);
    }

    const accounts = await this.expenseRepository.findAccountsByCodes([expenseAccountCode, fundingAccountCode]);
    const accountMap = new Map(accounts.map((account) => [account.code, account]));
    const expenseAccount = accountMap.get(expenseAccountCode);
    const fundingAccount = accountMap.get(fundingAccountCode);
    if (!expenseAccount || !fundingAccount) {
      const missingCodes = [expenseAccountCode, fundingAccountCode].filter((code) => !accountMap.has(code));
      throw new ExpenseApplicationError(`Unknown account codes: ${missingCodes.join(', ')}`, 400);
    }
    if (expenseAccount.type !== 'EXPENSE') {
      throw new ExpenseApplicationError(`Account ${expenseAccountCode} must be an EXPENSE account`, 400);
    }
    if (fundingAccount.type === 'INCOME' || fundingAccount.type === 'EXPENSE') {
      throw new ExpenseApplicationError(`Account ${fundingAccountCode} cannot fund an expense`, 400);
    }

    for (let attempt = 0; attempt < EXPENSE_CONFIG.reference.retryLimit; attempt += 1) {
      const expenseEntries = await this.expenseRepository.findExpenseReferences(expenseReferencePrefixForDate(expenseDate));
      const nextSequence = expenseEntries.reduce((max, entry) => {
        const match = entry.referenceId.match(/-(\d+)$/);
        return Math.max(max, match ? Number.parseInt(match[1], 10) : 0);
      }, 0) + 1;
      const referenceId = buildExpenseReferenceId(expenseDate, nextSequence);

      try {
        return await this.expenseRepository.transaction(async (tx) => ({
          expense: await this.expenseRepository.createExpense({
            expenseNo: referenceId,
            scope,
            shopId: scope === 'SHOP' ? shopId : null,
            createdByUserId: authenticatedContext.userId,
            sellerUserId: authenticatedContext.userId,
            expenseTypeId: expenseCategory.id,
            expenseAccountCode,
            fundingAccountCode,
            amount: input.amount,
            currency: EXPENSE_CONFIG.defaults.currency,
            description: description ?? null,
            receiptImage: receiptImage ?? null,
            expenseDate,
            status: EXPENSE_CONFIG.defaults.expenseStatus,
          }, tx),
          journalEntry: null,
        }));
      } catch (error) {
        if (isExpenseReferenceCollision(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new ExpenseApplicationError('Unable to generate a unique expense reference. Please try again.', 503);
  }

  async updateReturnedExpense(
    expenseId: string,
    input: Pick<CreateExpenseInput, 'amount' | 'expenseDate' | 'expenseCategoryId' | 'description' | 'receiptImage'>,
    authContext?: ExpenseAuthContext | null,
  ) {
    const authenticatedContext = this.authorizationPolicy.requireAuthenticatedUser(authContext);
    const expense = await this.expenseRepository.findExpenseById(expenseId);
    if (!expense || expense.sellerUserId !== authenticatedContext.userId) {
      throw new ExpenseApplicationError('Expense not found', 404);
    }
    if (expense.status !== 'RETURNED') {
      throw new ExpenseApplicationError('Only returned expenses can be edited', 400);
    }

    validateExpenseAmount(input.amount);
    const categoryId = input.expenseCategoryId?.trim();
    if (!categoryId) {
      throw new ExpenseApplicationError('Expense category is required', 400);
    }

    const category = await this.expenseRepository.findCategory(categoryId);
    if (!category || category.status !== EXPENSE_CONFIG.defaults.categoryStatus) {
      throw new ExpenseApplicationError('Unknown or inactive expense category', 400);
    }

    const receiptImage = validateReceiptImage(input.receiptImage);
    const expenseDate = parseExpenseDate(input.expenseDate, expense.expenseDate);
    try {
      return await this.expenseRepository.transaction((tx) => this.expenseRepository.updateReturnedExpense(expenseId, {
        amount: input.amount,
        expenseDate,
        expenseTypeId: category.id,
        description: input.description?.trim() || null,
        ...(receiptImage !== undefined ? { receiptImage } : {}),
        status: EXPENSE_CONFIG.defaults.expenseStatus,
        submittedAt: null,
      }, tx));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ExpenseApplicationError('Expense not found', 404);
      }
      throw error;
    }
  }

  async listExpenses(authContext?: ExpenseAuthContext | null, statuses?: ExpenseListStatus[]) {
    const authenticatedContext = this.authorizationPolicy.requireAuthenticatedUser(authContext);
    const expenses = this.authorizationPolicy.canAccessPlatformExpenses(authenticatedContext)
      ? await this.expenseRepository.listPlatformExpenses(statuses)
      : await this.expenseRepository.listExpenses(
        this.authorizationPolicy.getAuthorizedShopIds(authenticatedContext),
        statuses,
      );

    return expenses.map(({ approvals, ...expense }) => ({
      ...expense,
      approvedAt: approvals[0]?.approvedAt?.toISOString() ?? null,
    }));
  }

  async getExpenseByReference(referenceId: string, authContext?: ExpenseAuthContext | null) {
    const authenticatedContext = this.authorizationPolicy.requireAuthenticatedUser(authContext);
    const expense = this.authorizationPolicy.canAccessPlatformExpenses(authenticatedContext)
      ? await this.expenseRepository.findPlatformExpenseByReference(referenceId)
      : await this.expenseRepository.findExpenseByReference(
        referenceId,
        this.authorizationPolicy.getAuthorizedShopIds(authenticatedContext),
      );

    if (!expense) {
      return null;
    }

    const journalEntry = await this.expenseRepository.findJournalByExpenseReference(expense.expenseNo);
    return { ...expense, journalEntry };
  }
}
