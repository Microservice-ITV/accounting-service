import prisma from '../../../lib/prisma.js';
import type { IProfitLossRepository } from '../interfaces/profit-loss.repository.interface.js';
import type {
  ProfitLossQueryData,
  ScopedProfitLossQuery,
} from '../profit-loss.types.js';

const dateWhere = (from?: Date, to?: Date) => ({
  ...(from || to
    ? {
        gte: from,
        ...(to ? { lt: to } : {}),
      }
    : {}),
});

export class ProfitLossRepository implements IProfitLossRepository {
  async getProfitLossData(query: ScopedProfitLossQuery): Promise<ProfitLossQueryData> {
    const shopIds = query.scope.shopIds ?? undefined;
    const periodWhere = dateWhere(query.from, query.to);
    const [salesProjections, paymentLines, expenses] = await Promise.all([
      prisma.pnlOrderShop.findMany({
        where: {
          ...(shopIds ? { shopId: { in: shopIds } } : {}),
          orderPaidAt: periodWhere,
        },
        include: { discounts: true },
      }),
      prisma.paymentSettlementLine.findMany({
        where: {
          ...(shopIds ? { shopId: { in: shopIds } } : {}),
          settlement: { status: 'POSTED', createdAt: periodWhere },
        },
        include: {
          settlement: {
            select: { paymentReference: true, orderId: true, createdAt: true },
          },
        },
      }),
      prisma.expense.findMany({
        where: {
          scope: 'SHOP',
          status: 'APPROVED',
          shopId: {
            not: null,
            ...(shopIds ? { in: shopIds } : {}),
          },
          expenseDate: periodWhere,
        },
        select: {
          shopId: true,
          scope: true,
          status: true,
          currency: true,
          amount: true,
          expenseDate: true,
          expenseNo: true,
        },
      }),
    ]);

    const paymentReferences = [...new Set(paymentLines.map((line) => line.settlement.paymentReference))];
    const expenseReferences = expenses.map((expense) => expense.expenseNo);
    const entries = paymentReferences.length || expenseReferences.length
      ? await prisma.entryLine.findMany({
          where: {
            journalEntry: {
              OR: [
                ...(paymentReferences.length
                  ? [{
                      referenceType: 'PAYMENT',
                      referenceId: { in: paymentReferences },
                    }]
                  : []),
                ...(expenseReferences.length
                  ? [{
                      referenceType: 'EXPENSE',
                      referenceId: { in: expenseReferences },
                    }]
                  : []),
              ],
            },
          },
          include: {
            journalEntry: true,
            account: { select: { code: true, name: true, type: true } },
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    return {
      salesProjections,
      paymentLines,
      expenses,
      entries,
    };
  }
}
