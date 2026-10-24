import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import { ExpenseApplicationError } from '../errors/expense.error.js';
import type { IExpenseService } from '../interfaces/expense.service.interface.js';
import { expenseCategorySchema, expenseSchema, returnedExpenseSchema } from '../dto/expense.dto.js';

type ExpenseRequest = Request & { auth?: AuthenticatedExpenseContext };

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const getAuth = (req: ExpenseRequest) => req.auth ?? null;

export class ExpenseController {
  constructor(private readonly expenseService: IExpenseService) {}

  private respondWithError(res: Response, error: unknown, fallback: string) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message ?? fallback });
    }
    if (error instanceof ExpenseApplicationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: fallback });
  }

  async listCategories(_req: Request, res: Response) {
    try {
      return res.json({ categories: await this.expenseService.listExpenseCategories() });
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to fetch expense categories');
    }
  }

  async createCategory(req: Request, res: Response) {
    try {
      const input = expenseCategorySchema.parse(req.body ?? {});
      return res.status(201).json(await this.expenseService.createExpenseCategory(input));
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to create expense category');
    }
  }

  async updateCategory(req: Request, res: Response) {
    try {
      const input = expenseCategorySchema.parse(req.body ?? {});
      return res.json(await this.expenseService.updateExpenseCategory(getParam(req.params.id), input));
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to update expense category');
    }
  }

  async deleteCategory(req: Request, res: Response) {
    try {
      await this.expenseService.deleteExpenseCategory(getParam(req.params.id));
      return res.status(204).send();
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to delete expense category');
    }
  }

  async list(req: ExpenseRequest, res: Response) {
    try {
      return res.json(await this.expenseService.listExpenses(getAuth(req)));
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to fetch expenses');
    }
  }

  async getByReference(req: ExpenseRequest, res: Response) {
    try {
      const expense = await this.expenseService.getExpenseByReference(getParam(req.params.referenceId), getAuth(req));
      return expense ? res.json(expense) : res.status(404).json({ error: 'Expense not found' });
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to fetch expense');
    }
  }

  async create(req: ExpenseRequest, res: Response) {
    try {
      const input = expenseSchema.parse(req.body ?? {});
      return res.status(201).json(await this.expenseService.createExpense(input, getAuth(req)));
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to create expense');
    }
  }

  async updateReturned(req: ExpenseRequest, res: Response) {
    try {
      const input = returnedExpenseSchema.parse(req.body ?? {});
      return res.json(await this.expenseService.updateReturnedExpense(getParam(req.params.expenseId), input, getAuth(req)));
    } catch (error) {
      return this.respondWithError(res, error, 'Failed to update expense');
    }
  }
}
