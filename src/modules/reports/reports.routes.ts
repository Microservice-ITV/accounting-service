import { Router } from 'express';
import prisma from '../../lib/prisma.js';

const router = Router();

router.get('/reports/profit-loss', async (req, res) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    const entries = await prisma.entryLine.findMany({
      where: {
        journalEntry: {
          entryDate: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        },
        account: {
          type: { in: ['INCOME', 'EXPENSE'] },
        },
      },
      include: {
        account: true,
        journalEntry: true,
      },
    });

    const incomeLines = entries.filter((line) => line.account.type === 'INCOME' && line.direction === 'CREDIT');
    const expenseLines = entries.filter((line) => line.account.type === 'EXPENSE' && line.direction === 'DEBIT');

    const totalIncome = incomeLines.reduce((sum, line) => sum + Number(line.amount.toString()), 0);
    const totalExpense = expenseLines.reduce((sum, line) => sum + Number(line.amount.toString()), 0);

    res.json({
      totalIncome,
      totalExpense,
      netProfit: Number((totalIncome - totalExpense).toFixed(2)),
      entries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate profit-loss report';
    res.status(500).json({ error: message });
  }
});

export default router;
