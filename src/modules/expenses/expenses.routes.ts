import { Router } from 'express';
import { z } from 'zod';
import { requireExpenseAuth } from '../../middleware/auth.js';
import {
  createExpense,
  createExpenseCategory,
  deleteExpenseCategory,
  getExpenseByReference,
  listExpenseCategories,
  listExpenses,
  updateReturnedExpense,
  updateExpenseCategory,
} from './expense.service.js';

const router = Router();

const expenseSchema = z.object({
  shopId: z.string().trim().min(1),
  amount: z.coerce.number().finite().positive(),
  expenseDate: z.string().trim().min(1).optional(),
  expenseAccountCode: z.string().trim().min(1).optional(),
  fundingAccountCode: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  expenseCategoryId: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  receiptImage: z.string().optional(),
});

const expenseCategorySchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.get('/expenses/categories', async (_req, res) => {
  try {
    return res.json({ categories: await listExpenseCategories() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch expense categories' });
  }
});

router.post('/expenses/categories', async (req, res) => {
  try {
    return res.status(201).json(await createExpenseCategory(expenseCategorySchema.parse(req.body)));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || 'Invalid expense category payload'
      : error instanceof Error ? error.message : 'Failed to create expense category';
    return res.status(/unique/i.test(message) ? 409 : 400).json({ error: message });
  }
});

router.patch('/expenses/categories/:id', async (req, res) => {
  try {
    return res.json(await updateExpenseCategory(req.params.id, expenseCategorySchema.parse(req.body)));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || 'Invalid expense category payload'
      : error instanceof Error ? error.message : 'Failed to update expense category';
    return res.status(/Record to update not found/i.test(message) ? 404 : /unique/i.test(message) ? 409 : 400).json({ error: message });
  }
});

router.delete('/expenses/categories/:id', async (req, res) => {
  try {
    await deleteExpenseCategory(req.params.id);
    return res.status(204).send();
  } catch (error) {
    return res.status(/Record to delete not found/i.test(error instanceof Error ? error.message : '') ? 404 : 400)
      .json({ error: error instanceof Error ? error.message : 'Failed to delete expense category' });
  }
});

router.get('/expenses', requireExpenseAuth, async (req, res) => {
  try {
    const auth = (req as typeof req & { auth?: any }).auth ?? null;
    return res.json(await listExpenses(auth));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch expenses';
    return res.status(/Unauthorized|Unauthenticated/i.test(message) ? 403 : 500).json({ error: message });
  }
});

router.get('/expenses/reference/:referenceId', requireExpenseAuth, async (req, res) => {
  try {
    const auth = (req as typeof req & { auth?: any }).auth ?? null;
    const referenceId = Array.isArray(req.params.referenceId) ? req.params.referenceId[0] : req.params.referenceId;
    const expense = await getExpenseByReference(referenceId, auth);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    return res.json(expense);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch expense';
    return res.status(/Unauthorized|Unauthenticated/i.test(message) ? 403 : 500).json({ error: message });
  }
});

router.post('/expenses', requireExpenseAuth, async (req, res) => {
  try {
    const expense = expenseSchema.parse(req.body);
    const entry = await createExpense(expense, (req as typeof req & { auth?: any }).auth ?? null);
    return res.status(201).json(entry);
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message || 'Invalid expense payload'
      : error instanceof Error
        ? error.message
        : 'Failed to create expense';
    const status = /not authorized|Unauthenticated|Unauthorized|must belong|cannot be resolved|must be an|not found|invalid/i.test(message) ? 403 : 400;
    return res.status(status).json({ error: message });
  }
});

router.patch('/expenses/:expenseId', requireExpenseAuth, async (req, res) => {
  try {
    const payload = expenseSchema.pick({ amount: true, expenseDate: true, expenseCategoryId: true, description: true, receiptImage: true }).parse(req.body);
    const expenseId = Array.isArray(req.params.expenseId) ? req.params.expenseId[0] : req.params.expenseId;
    const expense = await updateReturnedExpense(expenseId, payload, (req as typeof req & { auth?: any }).auth ?? null);
    return res.json(expense);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message || 'Invalid expense payload' : error instanceof Error ? error.message : 'Failed to update expense';
    return res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
  }
});

export default router;
