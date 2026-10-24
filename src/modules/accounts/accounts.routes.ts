import { Router } from 'express';
import { AccountController } from './controllers/account.controller.js';
import { AccountRepository } from './repositories/account.repository.js';
import { AccountService } from './services/account.service.js';

const router = Router();
const accountController = new AccountController(
  new AccountService(new AccountRepository()),
);

router.get('/accounts', accountController.list);
router.get('/accounts/:code', accountController.getByCode);
router.post('/accounts', accountController.create);
router.patch('/accounts/:code', accountController.update);
router.patch('/accounts/:code/status', accountController.toggleStatus);

export default router;
