import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  getInventoryValuationReasons,
  InventoryValuationConflictError,
  InventoryValuationService,
  normalizeInventoryValuationEvent,
  resolveMovementCost,
  validateRunningValuation,
  type InventoryValuationEvent,
} from './inventory-valuation.service.js';

const event = (overrides: Partial<InventoryValuationEvent['data']> = {}): InventoryValuationEvent => ({
  event_id: 'valuation-event-1',
  event: 'inventory.valuation.movement',
  version: 'v1',
  timestamp: '2026-10-29T10:00:00.000Z',
  producer: 'warehouse-service',
  correlation_id: 'correlation-1',
  data: {
    movement_id: 'movement-1',
    movement_type: 'PURCHASE_RECEIVED',
    source_document_id: 'receipt-1',
    source_document_type: 'PURCHASE_RECEIPT',
    shop_id: 'shop-1',
    warehouse_id: 'warehouse-1',
    product_id: 'product-1',
    sku: 'SKU-1',
    variant_id: 'variant-1',
    quantity: 3,
    unit_cost_mmk: 125,
    total_cost_mmk: 375,
    currency: 'MMK',
    on_hand_qty: 8,
    average_unit_cost_mmk: 125,
    inventory_value_mmk: 1000,
    valuation_version: 2,
    occurred_at: '2026-10-29T09:59:00.000Z',
    original_currency: null,
    original_amount: null,
    applied_exchange_rate: null,
    rate_date: null,
    rate_source: null,
    ...overrides,
  },
});

test('inventory valuation envelope accepts the exact v1 warehouse contract', () => {
  assert.equal(normalizeInventoryValuationEvent(event()).data.movement_id, 'movement-1');
  assert.throws(() => normalizeInventoryValuationEvent({
    ...event(),
    data: { ...event().data, invented_code: 'not-accepted' },
  }));
  assert.throws(() => normalizeInventoryValuationEvent({
    ...event(),
    producer: 'other-service',
  }));
});

test('movement costs derive only from supplied quantity and unit cost and reject mismatches', () => {
  assert.deepEqual(resolveMovementCost(event().data), { amount: 375, reasons: [] });
  assert.deepEqual(
    resolveMovementCost(event({ total_cost_mmk: null }).data),
    { amount: 375, reasons: [] },
  );
  assert.match(
    resolveMovementCost(event({ total_cost_mmk: 350 }).data).reasons[0],
    /does not reconcile/,
  );
  assert.match(
    resolveMovementCost(event({ total_cost_mmk: null, unit_cost_mmk: null }).data).reasons[0],
    /unknown/,
  );
});

test('movement valuation requires matching stock quantity, average cost, and inventory value', () => {
  assert.deepEqual(getInventoryValuationReasons(event()), []);
  assert.ok(getInventoryValuationReasons(event({
    inventory_value_mmk: 990,
  })).some((reason) => reason.includes('does not reconcile')));
});

test('running quantity and WAC must roll forward from a known SKU snapshot', () => {
  const sale = event({
    movement_type: 'SALE_ISSUED',
    quantity: 2,
    unit_cost_mmk: 100,
    total_cost_mmk: 200,
    on_hand_qty: 8,
    average_unit_cost_mmk: 100,
    inventory_value_mmk: 800,
  });
  const prior = {
    onHandQty: 10,
    inventoryValueMmk: 1000,
    valuationVersion: 4,
    lastEventId: 'previous-event',
  };
  assert.deepEqual(validateRunningValuation(sale, prior), []);
  assert.ok(validateRunningValuation(event({
    ...sale.data,
    on_hand_qty: 7,
  }), prior).some((reason) => reason.includes('quantity roll-forward mismatch')));
  assert.ok(validateRunningValuation(event({
    ...sale.data,
    inventory_value_mmk: 700,
    average_unit_cost_mmk: 87.5,
  }), prior).some((reason) => reason.includes('Running inventory value/WAC mismatch')));
  assert.ok(validateRunningValuation(event(), null)
    .some((reason) => reason.includes('Opening inventory is unknown')));
});

test('unknown movement types are retained as unverified rather than posted with inferred semantics', () => {
  assert.ok(getInventoryValuationReasons(event({ movement_type: 'RETURN_RECEIVED' }))
    .some((reason) => reason.includes('semantics have not been verified')));
});

test('missing Finance mappings persist a valid event as blocked for replay', async () => {
  let updatedStatus = '';
  let savedPayload: unknown;
  const tx = {
    inventoryValuationMovement: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: { rawPayload: unknown } }) => {
        savedPayload = create.rawPayload;
        return { id: 'movement-record-1' };
      },
      update: async ({ data }: { data: { status: string } }) => {
        updatedStatus = data.status;
        return {};
      },
    },
    inventoryValuationSnapshot: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    inventoryAccountMapping: { findMany: async () => [] },
    journalEntry: { findFirst: async () => null },
  };
  const db = {
    $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const service = new InventoryValuationService(db);

  const result = await service.process(event());
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockReasons.some((reason) => reason.includes('INVENTORY_ASSET is missing')));
  assert.ok(result.blockReasons.some((reason) => reason.includes('PURCHASE_CLEARING is missing')));
  assert.equal(updatedStatus, 'BLOCKED');
  assert.deepEqual(savedPayload, event());
});

test('an event_id replay with changed data is rejected instead of overwriting its inbox record', async () => {
  const original = event();
  const tx = {
    inventoryValuationMovement: {
      findUnique: async () => ({
        status: 'BLOCKED',
        rawPayload: original,
      }),
    },
  };
  const db = {
    $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  const service = new InventoryValuationService(db);

  await assert.rejects(
    () => service.process(event({ total_cost_mmk: 400 })),
    InventoryValuationConflictError,
  );
});

test('report keeps each dashboard field separate, applies the report timeline, and does not invent reconciliation', async () => {
  const rows = [
    {
      movementType: 'INITIAL_BALANCE',
      status: 'POSTED',
      totalCostMmk: 100,
      inventoryValueMmk: 100,
      occurredAt: new Date('2026-09-30T12:00:00.000Z'),
      shopId: 'shop-1', warehouseId: 'warehouse-1', productId: 'product-1', sku: 'SKU-1',
      variantId: 'variant-1', onHandQty: 1, averageUnitCostMmk: 100,
      valuationVersion: 1, eventId: 'opening-event', blockReasons: [],
    },
    {
      movementType: 'PURCHASE_RECEIVED',
      status: 'POSTED',
      totalCostMmk: 50,
      inventoryValueMmk: 150,
      occurredAt: new Date('2026-10-10T12:00:00.000Z'),
      shopId: 'shop-1', warehouseId: 'warehouse-1', productId: 'product-1', sku: 'SKU-1',
      variantId: 'variant-1', onHandQty: 2, averageUnitCostMmk: 75,
      valuationVersion: 2, eventId: 'receipt-event', blockReasons: [],
    },
    {
      movementType: 'PURCHASE_RECEIVED',
      status: 'POSTED',
      totalCostMmk: 500,
      inventoryValueMmk: 650,
      occurredAt: new Date('2026-11-10T12:00:00.000Z'),
      shopId: 'shop-1', warehouseId: 'warehouse-1', productId: 'product-1', sku: 'SKU-1',
      variantId: 'variant-1', onHandQty: 3, averageUnitCostMmk: 216.67,
      valuationVersion: 3, eventId: 'future-event', blockReasons: [],
    },
  ];
  const db = {
    inventoryValuationMovement: {
      findMany: async ({ where }: { where: Record<string, any> }) => rows.filter((row) => {
        if (where.shopId?.in && !where.shopId.in.includes(row.shopId)) return false;
        if (where.warehouseId && where.warehouseId !== row.warehouseId) return false;
        if (where.sku && where.sku !== row.sku) return false;
        if (where.occurredAt?.lt && row.occurredAt >= where.occurredAt.lt) return false;
        if (where.occurredAt?.gte && row.occurredAt < where.occurredAt.gte) return false;
        if (where.occurredAt?.lte && row.occurredAt > where.occurredAt.lte) return false;
        return true;
      }),
    },
    warehouseInventorySourceEvent: {
      findMany: async () => [],
      count: async () => 0,
    },
    inventoryAccountMapping: {
      findMany: async () => [
        ['INVENTORY_ASSET', 'ASSET'], ['COGS', 'EXPENSE'],
        ['PURCHASE_CLEARING', 'LIABILITY'], ['OPENING_BALANCE_EQUITY', 'EQUITY'],
      ].map(([mappingKey, type]) => ({
        mappingKey,
        approvedByUserId: 'finance-1',
        account: { id: `id-${mappingKey}`, code: `db-code-${mappingKey}`, name: mappingKey, type, status: 'ACTIVE' },
      })),
    },
  };
  const service = new InventoryValuationService(db as unknown as PrismaClient);
  const report = await service.getReport({
    shopIds: ['shop-1'],
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: new Date('2026-10-31T23:59:59.999Z'),
    warehouseId: 'warehouse-1',
    sku: 'SKU-1',
  });

  assert.equal(report.metrics.openingInventoryValueMmk, 100);
  assert.equal(report.metrics.inventoryValueMmk, 150);
  assert.equal(report.metrics.purchaseCostMmk, 50);
  assert.equal(report.metrics.landedCostMmk, null);
  assert.equal(report.metrics.cogsMmk, null);
  assert.equal(report.metrics.purchaseReturnsMmk, null);
  assert.equal(report.metrics.salesReturnsMmk, null);
  assert.equal(report.metrics.damagedStockValueMmk, null);
  assert.equal(report.metrics.inventoryAdjustmentsMmk, null);
  assert.equal(report.metrics.reconciliationVarianceMmk, null);
  assert.ok(report.missingComponents.includes('landedCostSourceUnavailable'));
  assert.ok(report.missingComponents.includes('saleReturnEventsNotAvailableFromSource'));
  assert.ok(report.missingComponents.includes('damagedStockEventsNotAvailableFromSource'));
  assert.ok(report.missingComponents.includes('inventoryAdjustmentEventsNotAvailableFromSource'));
  assert.ok(report.missingComponents.includes('independentLedgerReconciliationSourceUnavailable'));
  assert.equal(report.valuation.length, 1);
  assert.equal(report.valuation[0].inventoryValueMmk, 150);
  assert.equal(report.valuation[0].asOf, '2026-10-10T12:00:00.000Z');
  assert.equal(report.inventoryAsOf, '2026-10-31T23:59:59.999Z');
});
