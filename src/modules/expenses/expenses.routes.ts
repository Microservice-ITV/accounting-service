import { Router } from 'express';
import { requireExpenseAuth } from '../../middleware/auth.js';
import { ExpenseController } from './controllers/expense.controller.js';
import { ExpenseAuthorizationPolicy } from './policies/expense-authorization.policy.js';
import { ExpenseRepository } from './repositories/expense.repository.js';
import { ExpenseService } from './services/expense.service.js';

const router = Router();
const expenseController = new ExpenseController(
  new ExpenseService(new ExpenseRepository(), new ExpenseAuthorizationPolicy()),
);

router.get('/expenses/categories', expenseController.listCategories.bind(expenseController));
router.post('/expenses/categories', expenseController.createCategory.bind(expenseController));
router.patch('/expenses/categories/:id', expenseController.updateCategory.bind(expenseController));
router.delete('/expenses/categories/:id', expenseController.deleteCategory.bind(expenseController));
router.get('/expenses', requireExpenseAuth, expenseController.list.bind(expenseController));
router.get('/expenses/reference/:referenceId', requireExpenseAuth, expenseController.getByReference.bind(expenseController));
router.post('/expenses', requireExpenseAuth, expenseController.create.bind(expenseController));
router.patch('/expenses/:expenseId', requireExpenseAuth, expenseController.updateReturned.bind(expenseController));

export default router;
