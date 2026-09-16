import { Router } from 'express';
import prisma from '../../lib/prisma.js';

const router = Router();

router.get('/accounts', async (_req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      orderBy: { code: 'asc' },
    });
    res.json(accounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch accounts';
    res.status(500).json({ error: message });
  }
});

router.get('/accounts/:code', async (req, res) => {
  try {
    const account = await prisma.account.findUnique({
      where: { code: req.params.code },
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    return res.json(account);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Account lookup failed';
    return res.status(500).json({ error: message });
  }
});

export default router;
