import { Router } from 'express';
import prisma from '../../lib/prisma.js';

export type OrderReturnStageResponse = {
  id: string;
  referenceType: 'ORDER_RETURNED';
  referenceId: string;
  eventId: string;
  orderId: string;
  shopId: string;
  reason: string;
  returnedAt: Date;
  status: 'RETURNED';
};

export type ListOrderReturnStages = () => Promise<OrderReturnStageResponse[]>;

const listOrderReturnStages: ListOrderReturnStages = async () => {
  const records = await prisma.orderReturnStage.findMany({
    orderBy: [{ returnedAt: 'desc' }, { orderId: 'asc' }],
  });

  return records.map((record) => ({
    id: record.id,
    referenceType: 'ORDER_RETURNED',
    referenceId: record.orderId,
    eventId: record.eventId,
    orderId: record.orderId,
    shopId: record.shopIds.join(', ') || '—',
    reason: record.reason,
    returnedAt: record.returnedAt,
    status: 'RETURNED',
  }));
};

export function createOrderReturnStageRouter(
  listRecords: ListOrderReturnStages = listOrderReturnStages,
) {
  const router = Router();

  router.get('/returns', async (_req, res) => {
    try {
      return res.json(await listRecords());
    } catch (error) {
      console.error('Failed to fetch order return stages', error);
      return res.status(500).json({ error: 'Failed to fetch order return records' });
    }
  });

  return router;
}

export default createOrderReturnStageRouter();
