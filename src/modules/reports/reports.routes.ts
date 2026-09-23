import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { resolveAuthenticatedExpenseContext } from '../../middleware/auth.js';

const router = Router();

const normalizeShopId = (value?: string | null) => String(value ?? '').trim();

export function resolveSellerShopScope(context?: {
  role?: string | null;
  activeShopId?: string | null;
  authorizedShopIds?: Iterable<string> | string[] | null;
} | null) {
  if (!context) {
    return null;
  }

  const role = normalizeShopId(context.role).toLowerCase();
  if (role.includes('admin') || role.includes('super')) {
    return null;
  }

  const activeShopId = normalizeShopId(context.activeShopId);
  if (activeShopId) {
    return activeShopId;
  }

  const authorizedShopIds = Array.from(context.authorizedShopIds ?? [])
    .map((shopId) => normalizeShopId(shopId))
    .filter(Boolean);

  if (authorizedShopIds.length === 1) {
    return authorizedShopIds[0];
  }

  if (authorizedShopIds.length === 0) {
    throw new Error('Seller must be assigned to a shop before accessing income reports');
  }

  throw new Error('Seller income reports require a single active shop; multiple shops are not allowed');
}

router.get('/reports/profit-loss', async (req, res) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    let authContext: Awaited<ReturnType<typeof resolveAuthenticatedExpenseContext>> | null = null;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        authContext = await resolveAuthenticatedExpenseContext(req);
      }
    } catch {
      authContext = null;
    }

    const scopedShopId = authContext ? resolveSellerShopScope(authContext) : null;

    const where: Record<string, unknown> = {
      journalEntry: {
        entryDate: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      account: {
        type: { in: ['INCOME', 'EXPENSE'] },
      },
    };

    if (scopedShopId) {
      Object.assign(where, {
        OR: [
          { memo: { contains: `shop=${scopedShopId}`, mode: 'insensitive' } },
          { memo: { contains: `shop_id=${scopedShopId}`, mode: 'insensitive' } },
          { journalEntry: { narration: { contains: `shop=${scopedShopId}`, mode: 'insensitive' } } },
          { journalEntry: { narration: { contains: `shop_id=${scopedShopId}`, mode: 'insensitive' } } },
        ],
      });
    }

    const entries = await prisma.entryLine.findMany({
      where,
      include: {
        account: true,
        journalEntry: true,
      },
    });

    const expenseReferences = entries
      .filter((line) => line.journalEntry.referenceType === 'EXPENSE')
      .map((line) => line.journalEntry.referenceId);
    const approvedExpenseReferences = new Set(
      (expenseReferences.length > 0
        ? await prisma.expense.findMany({
            where: { expenseNo: { in: expenseReferences }, status: 'APPROVED' },
            select: { expenseNo: true },
          })
        : []
      ).map((expense) => expense.expenseNo),
    );
    const postedEntries = entries.filter(
      (line) => line.journalEntry.referenceType !== 'EXPENSE'
        || approvedExpenseReferences.has(line.journalEntry.referenceId),
    );

    const incomeLines = postedEntries.filter((line) => line.account.type === 'INCOME' && line.direction === 'CREDIT');
    const expenseLines = postedEntries.filter((line) => line.account.type === 'EXPENSE' && line.direction === 'DEBIT');

    const totalIncome = incomeLines.reduce((sum, line) => sum + Number(line.amount.toString()), 0);
    const totalExpense = expenseLines.reduce((sum, line) => sum + Number(line.amount.toString()), 0);

    res.json({
      totalIncome,
      totalExpense,
      netProfit: Number((totalIncome - totalExpense).toFixed(2)),
      entries: postedEntries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate profit-loss report';
    const status = /single active shop|assigned to a shop|not authorized|Unauthorized|Unauthenticated/i.test(message) ? 403 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
