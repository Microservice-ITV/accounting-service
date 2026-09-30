import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { resolveAuthenticatedExpenseContext } from '../../middleware/auth.js';

const router = Router();

const normalizeShopId = (value?: string | null) => String(value ?? '').trim();

export function resolveSellerShopScope(context?: {
  role?: string | null;
  activeShopId?: string | null;
  authorizedShopIds?: Iterable<string> | string[] | null;
} | null): string[] | null {
  if (!context) {
    return null;
  }

  const role = normalizeShopId(context.role).toLowerCase();
  const platformRoles = new Set([
    'platform_super_admin',
    'super_admin',
    'platform_finance',
    'platform_director',
    'platform_cfo',
    'cfo',
  ]);
  if (platformRoles.has(role)) {
    return null;
  }

  const shopIds = new Set(Array.from(context.authorizedShopIds ?? [])
    .map((shopId) => normalizeShopId(shopId))
    .filter(Boolean));

  const activeShopId = normalizeShopId(context.activeShopId);
  if (activeShopId) {
    shopIds.add(activeShopId);
  }

  if (shopIds.size === 0) {
    throw new Error('Seller must be assigned to a shop before accessing income reports');
  }

  return Array.from(shopIds);
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

    const scopedShopIds = authContext ? resolveSellerShopScope(authContext) : null;

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

    if (scopedShopIds) {
      Object.assign(where, {
        OR: scopedShopIds.flatMap((shopId) => [
          { memo: { contains: `shop=${shopId}`, mode: 'insensitive' } },
          { memo: { contains: `shop_id=${shopId}`, mode: 'insensitive' } },
          { journalEntry: { narration: { contains: `shop=${shopId}`, mode: 'insensitive' } } },
          { journalEntry: { narration: { contains: `shop_id=${shopId}`, mode: 'insensitive' } } },
        ]),
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
