import prisma from '../../../lib/prisma.js';
import type { ArApLedgerLine, ArApScope, ArApSettlement, IArApRepository } from '../services/ar-ap.service.js';

export class ArApRepository implements IArApRepository {
  async getPostedLedgerLines(scope: ArApScope): Promise<ArApLedgerLine[]> {
    return prisma.entryLine.findMany({
      where: {
        account: { code: { in: ['1010', '1100', '1200', '1210', '2000', '2100', '2200'] } },
        journalEntry: { status: 'POSTED' },
        ...(scope.shopIds ? { shopId: { in: scope.shopIds } } : {}),
      },
      include: {
        account: { select: { code: true, name: true, type: true } },
        journalEntry: {
          select: {
            id: true,
            referenceType: true,
            referenceId: true,
            eventId: true,
            narration: true,
            entryDate: true,
            createdAt: true,
            status: true,
            lines: {
              include: {
                account: { select: { code: true, name: true, type: true } },
              },
              orderBy: { id: 'asc' },
            },
          },
        },
      },
      orderBy: [{ journalEntry: { entryDate: 'desc' } }, { id: 'desc' }],
    });
  }

  async getSettlementRecords(scope: ArApScope): Promise<ArApSettlement[]> {
    return prisma.paymentSettlement.findMany({
      where: scope.shopIds
        ? { lines: { some: { shopId: { in: scope.shopIds } } } }
        : {},
      include: {
        lines: scope.shopIds
          ? { where: { shopId: { in: scope.shopIds } } }
          : true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}