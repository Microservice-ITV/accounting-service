import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  processWarehouseInventoryEvent,
  WarehouseSourceEventConflictError,
} from './warehouse-inventory-events.js';

const envelope = <T,>(event: string, data: T, eventId = `${event}-1`) => ({
  event_id: eventId,
  event,
  version: 'v1',
  timestamp: '2026-10-30T10:00:00.000Z',
  producer: 'warehouse-service',
  correlation_id: 'receipt-1',
  data,
});

function fakeDatabase() {
  const rows: Array<Record<string, any>> = [];
  const tx = {
    warehouseInventorySourceEvent: {
      findMany: async ({ where }: { where: { eventId: string } }) =>
        rows.filter((row) => row.eventId === where.eventId),
      createMany: async ({ data }: { data: Array<Record<string, any>> }) => {
        rows.push(...data.map((row) => ({ id: `row-${rows.length}`, ...row })));
        return { count: data.length };
      },
      updateMany: async ({ where, data }: {
        where: Record<string, any>;
        data: Record<string, any>;
      }) => {
        let count = 0;
        rows.forEach((row) => {
          const eventTypeMatches = Array.isArray(where.eventType?.in)
            ? where.eventType.in.includes(row.eventType)
            : where.eventType === undefined || row.eventType === where.eventType;
          if (
            (where.correlationId === undefined || row.correlationId === where.correlationId)
            && (where.eventId === undefined || row.eventId === where.eventId)
            && row.productId === where.productId
            && eventTypeMatches
            && (where.shopId !== null || row.shopId === null)
          ) {
            Object.assign(row, data);
            count += 1;
          }
        });
        return { count };
      },
      findFirst: async ({ where, select }: { where: Record<string, any>; select: Record<string, boolean> }) => {
        const row = rows.find((candidate) =>
          candidate.correlationId === where.correlationId
          && candidate.productId === where.productId
          && candidate.eventType === where.eventType,
        );
        return row ? { shopId: select.shopId ? row.shopId : undefined } : null;
      },
    },
    $transaction: async (work: (client: PrismaClient) => Promise<unknown>) =>
      work(tx as unknown as PrismaClient),
  };
  return { db: tx as unknown as PrismaClient, rows };
}

test('stores goods received with raw cost and missing currency unvalued, correlates shop, and deduplicates', async () => {
  const { db, rows } = fakeDatabase();
  const stockEvent = envelope('inventory.updated', {
    productId: 'product-1',
    shopId: 'shop-1',
    totalStock: 10,
    availableStock: 8,
  }, 'stock-event-1');
  const receiptEvent = envelope('purchase.goods_received', {
    receipt_id: 'receipt-1',
    receipt_number: 'GRN-1',
    purchase_order_id: 'po-1',
    warehouse_id: 'warehouse-1',
    supplier_id: 'supplier-1',
    received_at: '2026-10-30T09:59:00.000Z',
    items: [{ product_id: 'product-1', variant_id: 'variant-1', quantity: 2, unit_cost: 12.5 }],
  }, 'receipt-event-1');

  assert.equal((await processWarehouseInventoryEvent(stockEvent, db)).status, 'STORED_UNVALUED');
  assert.equal((await processWarehouseInventoryEvent(receiptEvent, db)).status, 'STORED_UNVALUED');
  const movement = rows.find((row) => row.eventId === 'receipt-event-1');
  assert.equal(movement?.shopId, 'shop-1');
  assert.equal(movement?.warehouseId, 'warehouse-1');
  assert.equal(movement?.quantity, 2);
  assert.equal(movement?.reportedUnitCost, 12.5);
  assert.equal(movement?.currency, null);
  assert.match(movement?.blockReason, /currency/);

  assert.deepEqual(await processWarehouseInventoryEvent(receiptEvent, db), {
    status: 'DUPLICATE',
    records: 1,
  });
  assert.equal(rows.filter((row) => row.eventId === 'receipt-event-1').length, 1);
  await assert.rejects(
    () => processWarehouseInventoryEvent({
      ...receiptEvent,
      data: { ...receiptEvent.data, items: [{ ...receiptEvent.data.items[0], quantity: 3 }] },
    }, db),
    WarehouseSourceEventConflictError,
  );
});

test('stores supplier returns as negative unvalued movements and low-stock as a quantity-only event', async () => {
  const { db, rows } = fakeDatabase();
  const returnedEvent = envelope('purchase.goods_returned', {
    return_id: 'return-1',
    return_number: 'PRN-1',
    warehouse_id: 'warehouse-1',
    supplier_id: 'supplier-1',
    returned_at: '2026-10-30T10:00:00.000Z',
    items: [{ product_id: 'product-1', quantity: 1, unit_cost: 9 }],
  }, 'return-event-1');
  const lowStockEvent = envelope('inventory.low_stock', {
    product_id: 'product-1',
    shop_id: 'shop-1',
    warehouse_id: 'warehouse-1',
    available_stock: 2,
    threshold: 5,
  }, 'low-stock-event-1');

  await processWarehouseInventoryEvent(returnedEvent, db);
  await processWarehouseInventoryEvent(lowStockEvent, db);
  const returned = rows.find((row) => row.eventId === 'return-event-1');
  const lowStock = rows.find((row) => row.eventId === 'low-stock-event-1');
  assert.equal(returned?.movementType, 'PURCHASE_RETURNED');
  assert.equal(returned?.quantity, -1);
  assert.equal(returned?.currency, null);
  assert.equal(lowStock?.movementType, null);
  assert.equal(lowStock?.availableQty, 2);
  assert.equal(lowStock?.warehouseId, 'warehouse-1');
});
