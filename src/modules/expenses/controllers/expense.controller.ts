import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import type { IExpenseService } from '../interfaces/expense.service.interface.js';
import { expenseCategorySchema, expenseSchema, returnedExpenseSchema } from '../dto/expense.dto.js';

type ExpenseRequest = Request & { auth?: AuthenticatedExpenseContext };
const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const getAuth = (req: ExpenseRequest) => req.auth ?? null;
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export class ExpenseController {
  constructor(private readonly expenseService: IExpenseService) {}

  async listCategories(_req: Request, res: Response) {
    try { return res.json({ categories: await this.expenseService.listExpenseCategories() }); }
    catch (error) { return res.status(500).json({ error: messageOf(error, 'Failed to fetch expense categories') }); }
  }

  async createCategory(req: Request, res: Response) {
    try { return res.status(201).json(await this.expenseService.createExpenseCategory(expenseCategorySchema.parse(req.body))); }
    catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message || 'Invalid expense category payload' : messageOf(error, 'Failed to create expense category');
      return res.status(/unique/i.test(message) ? 409 : 400).json({ error: message });
    }
  }

  async updateCategory(req: Request, res: Response) {
    try { return res.json(await this.expenseService.updateExpenseCategory(getParam(req.params.id), expenseCategorySchema.parse(req.body))); }
    catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message || 'Invalid expense category payload' : messageOf(error, 'Failed to update expense category');
      return res.status(/Record to update not found/i.test(message) ? 404 : /unique/i.test(message) ? 409 : 400).json({ error: message });
    }
  }

  async deleteCategory(req: Request, res: Response) {
    try { await this.expenseService.deleteExpenseCategory(getParam(req.params.id)); return res.status(204).send(); }
    catch (error) { const message = messageOf(error, 'Failed to delete expense category'); return res.status(/Record to delete not found/i.test(message) ? 404 : 400).json({ error: message }); }
  }

  async list(req: ExpenseRequest, res: Response) {
    try { return res.json(await this.expenseService.listExpenses(getAuth(req))); }
    catch (error) { const message = messageOf(error, 'Failed to fetch expenses'); return res.status(/Unauthorized|Unauthenticated/i.test(message) ? 403 : 500).json({ error: message }); }
  }

  async getByReference(req: ExpenseRequest, res: Response) {
    try {
      const expense = await this.expenseService.getExpenseByReference(getParam(req.params.referenceId), getAuth(req));
      return expense ? res.json(expense) : res.status(404).json({ error: 'Expense not found' });
    } catch (error) { const message = messageOf(error, 'Failed to fetch expense'); return res.status(/Unauthorized|Unauthenticated/i.test(message) ? 403 : 500).json({ error: message }); }
  }

  async create(req: ExpenseRequest, res: Response) {
    try { return res.status(201).json(await this.expenseService.createExpense(expenseSchema.parse(req.body), getAuth(req))); }
    catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message || 'Invalid expense payload' : messageOf(error, 'Failed to create expense');
      const status = /not authorized|Unauthenticated|Unauthorized|must belong|cannot be resolved|must be an|not found|invalid/i.test(message) ? 403 : 400;
      return res.status(status).json({ error: message });
    }
  }

  async updateReturned(req: ExpenseRequest, res: Response) {
    try { return res.json(await this.expenseService.updateReturnedExpense(getParam(req.params.expenseId), returnedExpenseSchema.parse(req.body), getAuth(req))); }
    catch (error) { const message = error instanceof z.ZodError ? error.issues[0]?.message || 'Invalid expense payload' : messageOf(error, 'Failed to update expense'); return res.status(/not found/i.test(message) ? 404 : 400).json({ error: message }); }
  }
}