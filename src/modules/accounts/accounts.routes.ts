import { Router } from 'express';
import { z } from 'zod';
import {
  createAccount,
  getAccountByCode,
  listAccounts,
  toggleAccountStatus,
  updateAccount,
} from './account.service.js';

const router = Router();

const accountSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  parentCode: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const sendValidationError = (res: any, error: unknown, fallback: string) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: error.issues[0]?.message ?? fallback });
  }
  if (error instanceof Error && /unique|already exists/i.test(error.message)) {
    return res.status(409).json({ error: 'Account code already exists' });
  }
  return res.status(400).json({ error: error instanceof Error ? error.message : fallback });
};

router.get('/accounts', async (_req, res) => {
  try {
    return res.json(await listAccounts());
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch accounts' });
  }
});

router.get('/accounts/:code', async (req, res) => {
  try {
    const account = await getAccountByCode(req.params.code);
    return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Account lookup failed' });
  }
});

router.post('/accounts', async (req, res) => {
  try {
    return res.status(201).json(await createAccount(accountSchema.parse(req.body)));
  } catch (error) {
    return sendValidationError(res, error, 'Invalid account payload');
  }
});

router.patch('/accounts/:code', async (req, res) => {
  try {
    const account = await updateAccount(req.params.code, accountSchema.parse(req.body));
    return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
  } catch (error) {
    return sendValidationError(res, error, 'Invalid account payload');
  }
});

router.patch('/accounts/:code/status', async (req, res) => {
  try {
    const account = await toggleAccountStatus(req.params.code);
    return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to update account status' });
  }
});

export default router;
