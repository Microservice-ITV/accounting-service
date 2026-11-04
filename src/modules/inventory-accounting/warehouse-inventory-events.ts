import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';

const dateTime = z.string().datetime({ offset: true });
const envelopeBase = {
  event_id: z.string().min(1),
  version: z.literal('v1'),
  timestamp: dateTime,
  producer: z.literal('warehouse-service'),
  correlation_id: z.string().min(1),
};

const inventoryUpdatedSchema = z.object({
  ...envelopeBase,
  event: z.literal('inventory.updated'),
  data: z.object({
    productId: z.string().min(1),
    shopId: z.string().min(1),
    totalStock: z.number().finite().nonnegative(),
    availableStock: z.number().finite().nonnegative(),
  }).passthrough(),
}).passthrough();

const inventoryLowStockSchema = z.object({
  ...envelopeBase,
  event: z.literal('inventory.low_stock'),
  data: z.object({
    product_id: z.string().min(1),
    shop_id: z.string().min(1),
    warehouse_id: z.string().min(1),
    available_stock: z.number().finite().nonnegative(),
    threshold: z.number().finite().nonnegative(),
  }).passthrough(),
}).passthrough();

const goodsReceivedSchema = z.object({
  ...envelopeBase,
  event: z.literal('purchase.goods_received'),
  data: z.object({
    receipt_id: z.string().min(1),
    receipt_number: z.string().min(1),
    purchase_order_id: z.string().min(1),
    warehouse_id: z.string().min(1),
    supplier_id: z.string().nullable(),
    received_at: dateTime,
    items: z.array(z.object({
      product_id: z.string().min(1),
      variant_id: z.string().optional(),
      quantity: z.number().finite().positive(),
      unit_cost: z.number().finite().nonnegative(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

const goodsReturnedSchema = z.object({
  ...envelopeBase,
  event: z.literal('purchase.goods_returned'),
  data: z.object({
    return_id: z.string().min(1),
    return_number: z.string().min(1),
    warehouse_id: z.string().min(1),
    supplier_id: z.string().min(1),
    returned_at: dateTime,
    items: z.array(z.object({
      product_id: z.string().min(1),
      variant_id: z.string().optional(),
      quantity: z.number().finite().positive(),
      unit_cost: z.number().finite().nonnegative(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

const schemas = [
  inventoryUpdatedSchema,
  inventoryLowStockSchema,
  goodsReceivedSchema,
  goodsReturnedSchema,
] as const;

type WarehouseSourceEvent =
  | z.infer<typeof inventoryUpdatedSchema>
  | z.infer<typeof inventoryLowStockSchema>
  | z.infer<typeof goodsReceivedSchema>
  | z.infer<typeof goodsReturnedSchema>;
type Db = typeof prisma;

type SourceRow = {
  eventId: string;
  lineIndex: number;
  eventType: string;
  correlationId: string;
  eventTimestamp: Date;
  occurredAt: Date;
  sourceDocumentId: string | null;
  sourceDocumentType: string | null;
  movementType: string | null;
  productId: string | null;
  sku: string | null;
  variantId: string | null;
  shopId: string | null;
  warehouseId: string | null;
  quantity: number | null;
  availableQty: number | null;
  onHandQty: number | null;
  reportedUnitCost: number | null;
  currency: string | null;
  blockReason: string;
  rawPayload: Prisma.InputJsonValue;
};

export class WarehouseSourceEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseSourceEventConflictError';
  }
}

function parseWarehouseEvent(raw: unknown): WarehouseSourceEvent {
  for (const schema of schemas) {
    const result = schema.safeParse(raw);
    if (result.success) return result.data as WarehouseSourceEvent;
  }
  return schemas[0].parse(raw) as never;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toSourceRows(event: WarehouseSourceEvent): SourceRow[] {
  const common = {
    eventId: event.event_id,
    correlationId: event.correlation_id,
    eventTimestamp: new Date(event.timestamp),
    rawPayload: event as unknown as Prisma.InputJsonValue,
    sku: null,
    currency: null,
  };
  if (event.event === 'inventory.updated') {
    return [{
      ...common,
      lineIndex: 0,
      eventType: event.event,
      occurredAt: new Date(event.timestamp),
      sourceDocumentId: event.correlation_id,
      sourceDocumentType: null,
      movementType: null,
      productId: event.data.productId,
      variantId: null,
      shopId: event.data.shopId,
      warehouseId: null,
      quantity: null,
      availableQty: event.data.availableStock,
      onHandQty: event.data.totalStock,
      reportedUnitCost: null,
      blockReason: 'Aggregate product stock snapshot; warehouse and inventory cost are not provided.',
    }];
  }
  if (event.event === 'inventory.low_stock') {
    return [{
      ...common,
      lineIndex: 0,
      eventType: event.event,
      occurredAt: new Date(event.timestamp),
      sourceDocumentId: event.correlation_id,
      sourceDocumentType: null,
      movementType: null,
      productId: event.data.product_id,
      variantId: null,
      shopId: event.data.shop_id,
      warehouseId: event.data.warehouse_id,
      quantity: null,
      availableQty: event.data.available_stock,
      onHandQty: null,
      reportedUnitCost: null,
      blockReason: 'Low-stock alert reports available quantity, not a stock movement or inventory cost.',
    }];
  }

  if (event.event === 'purchase.goods_received') {
    return event.data.items.map((item, lineIndex) => ({
      ...common,
      lineIndex,
      eventType: event.event,
      occurredAt: new Date(event.data.received_at),
      sourceDocumentId: event.data.receipt_id,
      sourceDocumentType: 'PURCHASE_RECEIPT',
      movementType: 'PURCHASE_RECEIVED',
      productId: item.product_id,
      variantId: item.variant_id ?? null,
      shopId: null,
      warehouseId: event.data.warehouse_id,
      quantity: item.quantity,
      availableQty: null,
      onHandQty: null,
      reportedUnitCost: item.unit_cost,
      blockReason: 'Warehouse event omits the item currency, authoritative running stock quantity, and shop attribution.',
    }));
  }
  return event.data.items.map((item, lineIndex) => ({
    ...common,
    lineIndex,
    eventType: event.event,
    occurredAt: new Date(event.data.returned_at),
    sourceDocumentId: event.data.return_id,
    sourceDocumentType: 'PURCHASE_RETURN',
    movementType: 'PURCHASE_RETURNED',
    productId: item.product_id,
    variantId: item.variant_id ?? null,
    shopId: null,
    warehouseId: event.data.warehouse_id,
    quantity: -item.quantity,
    availableQty: null,
    onHandQty: null,
    reportedUnitCost: item.unit_cost,
    blockReason: 'Warehouse event omits the item currency, authoritative running stock quantity, and shop attribution.',
  }));
}

export async function processWarehouseInventoryEvent(
  raw: unknown,
  database: Db = prisma,
): Promise<{
  status: 'STORED_UNVALUED' | 'DUPLICATE';
  records: number;
}> {
  const event = parseWarehouseEvent(raw);
  const sourceRows = toSourceRows(event);
  return database.$transaction(async (tx) => {
    const existing = await tx.warehouseInventorySourceEvent.findMany({
      where: { eventId: event.event_id },
    });
    if (existing.length) {
      if (existing.some((row) => canonicalJson(row.rawPayload) !== canonicalJson(event))) {
        throw new WarehouseSourceEventConflictError(
          `event_id ${event.event_id} was already received with a different payload`,
        );
      }
      return { status: 'DUPLICATE', records: existing.length };
    }

    await tx.warehouseInventorySourceEvent.createMany({ data: sourceRows });

    if (event.event === 'inventory.updated') {
      await tx.warehouseInventorySourceEvent.updateMany({
        where: {
          correlationId: event.correlation_id,
          productId: event.data.productId,
          eventType: { in: ['purchase.goods_received', 'purchase.goods_returned'] },
          shopId: null,
        },
        data: { shopId: event.data.shopId },
      });
    } else if (event.event === 'purchase.goods_received' || event.event === 'purchase.goods_returned') {
      for (const item of event.data.items) {
        const stockEvent = await tx.warehouseInventorySourceEvent.findFirst({
          where: {
            correlationId: event.correlation_id,
            productId: item.product_id,
            eventType: 'inventory.updated',
          },
          select: { shopId: true },
        });
        if (stockEvent?.shopId) {
          await tx.warehouseInventorySourceEvent.updateMany({
            where: {
              eventId: event.event_id,
              productId: item.product_id,
              shopId: null,
            },
            data: { shopId: stockEvent.shopId },
          });
        }
      }
    }
    return { status: 'STORED_UNVALUED', records: sourceRows.length };
  });
}
