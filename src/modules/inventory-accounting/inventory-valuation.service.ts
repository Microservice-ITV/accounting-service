import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { createJournalEntryInTransaction } from '../entries/services/entry.service.js';

const nullableMoney = z.number().finite().nullable();
const dateTime = z.string().datetime({ offset: true });

export const inventoryValuationEventSchema = z.object({
  event_id: z.string().min(1),
  event: z.literal('inventory.valuation.movement'),
  version: z.literal('v1'),
  timestamp: dateTime,
  producer: z.literal('warehouse-service'),
  correlation_id: z.string().min(1),
  data: z.object({
    movement_id: z.string().min(1),
    movement_type: z.string().min(1),
    source_document_id: z.string().min(1),
    source_document_type: z.string().min(1),
    shop_id: z.string().min(1),
    warehouse_id: z.string().min(1),
    product_id: z.string().min(1),
    sku: z.string().nullable(),
    variant_id: z.string().min(1),
    quantity: z.number().finite(),
    unit_cost_mmk: nullableMoney,
    total_cost_mmk: nullableMoney,
    currency: z.literal('MMK'),
    on_hand_qty: z.number().finite(),
    average_unit_cost_mmk: nullableMoney,
    inventory_value_mmk: nullableMoney,
    valuation_version: z.number().int(),
    occurred_at: dateTime,
    original_currency: z.string().nullable(),
    original_amount: nullableMoney,
    applied_exchange_rate: z.number().finite().nullable(),
    rate_date: z.string().nullable(),
    rate_source: z.string().nullable(),
  }).strict(),
}).strict();

export type InventoryValuationEvent = z.infer<typeof inventoryValuationEventSchema>;
export type InventoryMovementType = 'PURCHASE_RECEIVED' | 'PURCHASE_RETURNED' | 'SALE_ISSUED' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'INITIAL_BALANCE';
export type InventoryMappingKey = 'INVENTORY_ASSET' | 'COGS' | 'PURCHASE_CLEARING' | 'OPENING_BALANCE_EQUITY';

const mappingTypes: Record<InventoryMappingKey, string> = {
  INVENTORY_ASSET: 'ASSET',
  COGS: 'EXPENSE',
  PURCHASE_CLEARING: 'LIABILITY',
  OPENING_BALANCE_EQUITY: 'EQUITY',
};

const requiredMappings: Partial<Record<InventoryMovementType, InventoryMappingKey[]>> = {
  PURCHASE_RECEIVED: ['INVENTORY_ASSET', 'PURCHASE_CLEARING'],
  PURCHASE_RETURNED: ['INVENTORY_ASSET', 'PURCHASE_CLEARING'],
  SALE_ISSUED: ['INVENTORY_ASSET', 'COGS'],
  INITIAL_BALANCE: ['INVENTORY_ASSET', 'OPENING_BALANCE_EQUITY'],
};

const financialMovementTypes = new Set<string>(Object.keys(requiredMappings));
const neutralMovementTypes = new Set(['TRANSFER_IN', 'TRANSFER_OUT']);
const cents = (amount: number) => Math.round((amount + Number.EPSILON) * 100);
const fromDecimal = (value: { toString(): string } | number | null): number | null =>
  value === null ? null : Number(value.toString());

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class InventoryValuationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryValuationConflictError';
  }
}

export function normalizeInventoryValuationEvent(raw: unknown): InventoryValuationEvent {
  return inventoryValuationEventSchema.parse(raw);
}

export function resolveMovementCost(data: InventoryValuationEvent['data']): {
  amount: number | null;
  reasons: string[];
} {
  if (data.total_cost_mmk === null && data.unit_cost_mmk === null) {
    return { amount: null, reasons: ['Movement cost is unknown (total_cost_mmk and unit_cost_mmk are null)'] };
  }

  const calculated = data.unit_cost_mmk === null
    ? null
    : cents(data.quantity * data.unit_cost_mmk);
  if (data.total_cost_mmk !== null && calculated !== null && cents(data.total_cost_mmk) !== calculated) {
    return { amount: null, reasons: ['total_cost_mmk does not reconcile to quantity × unit_cost_mmk'] };
  }

  const amount = data.total_cost_mmk ?? (calculated === null ? null : calculated / 100);
  if (amount === null || amount <= 0) {
    return { amount, reasons: ['Movement cost must be known and positive before journal posting'] };
  }
  return { amount, reasons: [] };
}

export function getInventoryValuationReasons(event: InventoryValuationEvent): string[] {
  const { data } = event;
  const reasons = resolveMovementCost(data).reasons;
  if (data.quantity <= 0) reasons.push('quantity must be positive for inventory posting');
  if (data.on_hand_qty < 0) reasons.push('on_hand_qty cannot be negative');
  if (data.valuation_version <= 0) reasons.push('valuation_version must be positive');
  if (data.unit_cost_mmk !== null && data.unit_cost_mmk < 0) reasons.push('unit_cost_mmk cannot be negative');
  if (data.total_cost_mmk !== null && data.total_cost_mmk < 0) reasons.push('total_cost_mmk cannot be negative');
  if (data.average_unit_cost_mmk !== null && data.average_unit_cost_mmk < 0) reasons.push('average_unit_cost_mmk cannot be negative');
  if (data.inventory_value_mmk !== null && data.inventory_value_mmk < 0) reasons.push('inventory_value_mmk cannot be negative');
  if (data.applied_exchange_rate !== null && data.applied_exchange_rate <= 0) {
    reasons.push('applied_exchange_rate must be positive when supplied');
  }
  if (!financialMovementTypes.has(data.movement_type) && !neutralMovementTypes.has(data.movement_type)) {
    reasons.push(`Unsupported movement_type ${data.movement_type}; source semantics have not been verified`);
  }
  if (
    data.inventory_value_mmk !== null
    && data.average_unit_cost_mmk !== null
    && Math.abs(cents(data.inventory_value_mmk) - cents(data.on_hand_qty * data.average_unit_cost_mmk)) > 1
  ) {
    reasons.push('inventory_value_mmk does not reconcile to on_hand_qty × average_unit_cost_mmk');
  }
  return [...new Set(reasons)];
}

type AccountMapping = {
  mappingKey: string;
  account: { id: string; code: string; type: string; status: string };
};

export function getRequiredInventoryMappings(movementType: string): InventoryMappingKey[] {
  if (neutralMovementTypes.has(movementType)) return [];
  return requiredMappings[movementType as InventoryMovementType] ?? [];
}

function mappingValidationReasons(
  movementType: string,
  mappings: AccountMapping[],
): string[] {
  const reasons: string[] = [];
  const byKey = new Map(mappings.map((mapping) => [mapping.mappingKey, mapping]));
  for (const key of getRequiredInventoryMappings(movementType)) {
    const mapping = byKey.get(key);
    if (!mapping) {
      reasons.push(`Required Finance account mapping ${key} is missing`);
      continue;
    }
    if (mapping.account.type !== mappingTypes[key]) {
      reasons.push(`Finance account mapping ${key} must reference an ${mappingTypes[key]} account`);
    }
    if (mapping.account.status !== 'ACTIVE') {
      reasons.push(`Finance account mapping ${key} references an inactive account`);
    }
  }
  return reasons;
}

export type InventoryValuationReport = {
  complete: boolean;
  missingComponents: string[];
  coverageFrom: string | null;
  totalInventoryQuantity: number | null;
  totalAvailableQuantity: number | null;
  quantityAsOf: string | null;
  metrics: {
    inventoryValueMmk: number | null;
    purchaseCostMmk: number | null;
    landedCostMmk: null;
    cogsMmk: number | null;
    purchaseReturnsMmk: number | null;
    salesReturnsMmk: null;
    damagedStockValueMmk: null;
    inventoryAdjustmentsMmk: null;
    openingInventoryValueMmk: number | null;
    reconciliationVarianceMmk: null;
  };
  inventoryAsOf: string | null;
  valuation: Array<{
    sku: string | null;
    productId: string;
    variantId: string;
    warehouseId: string;
    shopId: string;
    onHandQty: number;
    averageUnitCostMmk: number | null;
    inventoryValueMmk: number | null;
    valuationVersion: number;
    asOf: string;
  }>;
  movementHistory: {
    items: Array<{
      sourceEventId: string;
      eventType: string;
      movementType: string | null;
      sourceDocumentId: string | null;
      sourceDocumentType: string | null;
      correlationId: string;
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
      occurredAt: string;
      blockReason: string;
    }>;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function lineEntryType(movementType: string): string {
  return movementType === 'SALE_ISSUED' ? 'COGS' : movementType;
}

function getPostingLines(
  event: InventoryValuationEvent,
  amount: number,
  mappings: AccountMapping[],
) {
  const byKey = new Map(mappings.map((mapping) => [mapping.mappingKey, mapping]));
  const inventory = byKey.get('INVENTORY_ASSET')?.account.code;
  const offsetKey = lineEntryType(event.data.movement_type) === 'COGS'
    ? 'COGS'
    : event.data.movement_type === 'INITIAL_BALANCE'
      ? 'OPENING_BALANCE_EQUITY'
      : 'PURCHASE_CLEARING';
  const offset = byKey.get(offsetKey)?.account.code;
  if (!inventory || !offset) return [];

  const debitAccountCode = event.data.movement_type === 'PURCHASE_RETURNED' ? offset : inventory;
  const creditAccountCode = event.data.movement_type === 'PURCHASE_RETURNED' ? inventory : offset;
  return [
    { accountCode: debitAccountCode, direction: 'DEBIT' as const, amount, currency: 'MMK', shopId: event.data.shop_id, memo: `Inventory movement ${event.data.movement_id}` },
    { accountCode: creditAccountCode, direction: 'CREDIT' as const, amount, currency: 'MMK', shopId: event.data.shop_id, memo: `Inventory movement ${event.data.movement_id}` },
  ];
}

function snapshotKey(data: InventoryValuationEvent['data']) {
  return {
    shopId_warehouseId_productId_variantId: {
      shopId: data.shop_id,
      warehouseId: data.warehouse_id,
      productId: data.product_id,
      variantId: data.variant_id,
    },
  };
}

function snapshotData(event: InventoryValuationEvent) {
  const { data } = event;
  return {
    shopId: data.shop_id,
    warehouseId: data.warehouse_id,
    productId: data.product_id,
    sku: data.sku,
    variantId: data.variant_id,
    onHandQty: data.on_hand_qty,
    averageUnitCostMmk: data.average_unit_cost_mmk,
    inventoryValueMmk: data.inventory_value_mmk,
    valuationVersion: data.valuation_version,
    lastEventId: event.event_id,
    asOf: new Date(data.occurred_at),
  };
}

type ValuationSnapshotState = {
  onHandQty: { toString(): string } | number;
  inventoryValueMmk: { toString(): string } | number | null;
  valuationVersion: number;
  lastEventId: string;
};

const quantityDeltaSign: Record<string, number> = {
  PURCHASE_RECEIVED: 1,
  PURCHASE_RETURNED: -1,
  SALE_ISSUED: -1,
  TRANSFER_IN: 1,
  TRANSFER_OUT: -1,
};

/**
 * Validate per-SKU stock movement against the previously accepted running valuation.
 * The event contract has no before-quantity field, so the prior snapshot (or an explicit
 * INITIAL_BALANCE) is required to establish both the quantity and WAC roll-forward.
 */
export function validateRunningValuation(
  event: InventoryValuationEvent,
  previous: ValuationSnapshotState | null,
): string[] {
  const { data } = event;
  const cost = resolveMovementCost(data);
  if (data.movement_type === 'INITIAL_BALANCE') {
    if (previous) return ['INITIAL_BALANCE cannot replace an existing SKU/variant/warehouse valuation'];
    const reasons: string[] = [];
    if (Math.abs(data.on_hand_qty - data.quantity) > 0.0001) {
      reasons.push('INITIAL_BALANCE quantity must equal the resulting on_hand_qty');
    }
    if (cost.amount === null || data.inventory_value_mmk === null) {
      reasons.push('INITIAL_BALANCE requires verified movement cost and inventory value');
    } else if (Math.abs(cents(cost.amount) - cents(data.inventory_value_mmk)) > 1) {
      reasons.push('INITIAL_BALANCE cost does not reconcile to inventory_value_mmk');
    }
    return reasons;
  }

  if (!previous) {
    return ['Opening inventory is unknown; an INITIAL_BALANCE or prior valuation is required'];
  }
  const sign = quantityDeltaSign[data.movement_type];
  if (sign === undefined) {
    return [`Cannot validate running quantity for unsupported movement_type ${data.movement_type}`];
  }

  const previousQty = Number(previous.onHandQty.toString());
  const expectedQty = previousQty + sign * data.quantity;
  const reasons: string[] = [];
  if (Math.abs(expectedQty - data.on_hand_qty) > 0.0001) {
    reasons.push(`SKU-level quantity roll-forward mismatch: expected ${expectedQty}, received ${data.on_hand_qty}`);
  }
  const previousValue = fromDecimal(previous.inventoryValueMmk);
  if (previousValue === null || data.inventory_value_mmk === null || cost.amount === null) {
    reasons.push('Running WAC cannot be verified without prior and current inventory value and movement cost');
    return reasons;
  }
  const expectedValue = previousValue + sign * cost.amount;
  if (expectedValue < -0.01 || Math.abs(cents(expectedValue) - cents(data.inventory_value_mmk)) > 1) {
    reasons.push(
      `Running inventory value/WAC mismatch: expected ${roundMoney(expectedValue)}, received ${data.inventory_value_mmk}`,
    );
  }
  return reasons;
}

export class InventoryValuationService {
  constructor(private readonly db = prisma) {}

  async process(raw: unknown): Promise<{ status: string; blockReasons: string[] }> {
    const event = normalizeInventoryValuationEvent(raw);
    return this.db.$transaction(async (tx) => {
      const previous = await tx.inventoryValuationMovement.findUnique({ where: { eventId: event.event_id } });
      if (previous && canonicalJson(previous.rawPayload) !== canonicalJson(event)) {
        throw new InventoryValuationConflictError(
          `event_id ${event.event_id} was already received with a different payload`,
        );
      }
      if (previous?.status === 'POSTED' || previous?.status === 'POSTED_NO_JOURNAL') {
        return { status: previous.status, blockReasons: [] };
      }

      const data = event.data;
      const key = snapshotKey(data);
      const existingJournal = await tx.journalEntry.findFirst({
        where: {
          referenceType: 'INVENTORY_VALUATION_MOVEMENT',
          referenceId: data.movement_id,
        },
        select: { id: true, eventId: true },
      });
      const currentSnapshot = await tx.inventoryValuationSnapshot.findUnique({ where: key });
      const reasons = getInventoryValuationReasons(event);
      reasons.push(...validateRunningValuation(event, currentSnapshot));
      if (existingJournal && existingJournal.eventId !== event.event_id) {
        reasons.push('A different event is already posted for this movement_id');
      }
      if (currentSnapshot && data.valuation_version <= currentSnapshot.valuationVersion
        && currentSnapshot.lastEventId !== event.event_id) {
        reasons.push('Valuation version is not newer than the existing SKU/variant/warehouse snapshot');
      }

      const movementCost = resolveMovementCost(data);
      const movementRow = await tx.inventoryValuationMovement.upsert({
        where: { eventId: event.event_id },
        create: {
          eventId: event.event_id,
          movementId: data.movement_id,
          movementType: data.movement_type,
          sourceDocumentId: data.source_document_id,
          sourceDocumentType: data.source_document_type,
          shopId: data.shop_id,
          warehouseId: data.warehouse_id,
          productId: data.product_id,
          sku: data.sku,
          variantId: data.variant_id,
          quantity: data.quantity,
          unitCostMmk: data.unit_cost_mmk,
          totalCostMmk: movementCost.amount,
          currency: data.currency,
          onHandQty: data.on_hand_qty,
          averageUnitCostMmk: data.average_unit_cost_mmk,
          inventoryValueMmk: data.inventory_value_mmk,
          valuationVersion: data.valuation_version,
          occurredAt: new Date(data.occurred_at),
          eventTimestamp: new Date(event.timestamp),
          originalCurrency: data.original_currency,
          originalAmount: data.original_amount,
          appliedExchangeRate: data.applied_exchange_rate,
          rateDate: data.rate_date,
          rateSource: data.rate_source,
          status: 'BLOCKED',
          blockReasons: reasons,
          rawPayload: event as unknown as Prisma.InputJsonValue,
        },
        update: {
          blockReasons: reasons,
          rawPayload: event as unknown as Prisma.InputJsonValue,
          totalCostMmk: movementCost.amount,
          updatedAt: new Date(),
        },
      });

      const stale = currentSnapshot && data.valuation_version <= currentSnapshot.valuationVersion
        && currentSnapshot.lastEventId !== event.event_id;
      const projectionIsSafe = !reasons.some((reason) =>
        reason.startsWith('inventory_value_mmk does not reconcile')
        || reason.startsWith('quantity ')
        || reason.startsWith('on_hand_qty ')
        || reason.startsWith('valuation_version ')
        || reason.startsWith('Opening inventory is unknown')
        || reason.startsWith('SKU-level quantity roll-forward mismatch')
        || reason.startsWith('Running WAC cannot be verified')
        || reason.startsWith('Running inventory value/WAC mismatch')
        || reason.startsWith('INITIAL_BALANCE ')
        || reason.startsWith('A different event is already posted'),
      );
      if (!stale && projectionIsSafe) {
        await tx.inventoryValuationSnapshot.upsert({
          where: key,
          create: snapshotData(event),
          update: snapshotData(event),
        });
      }

      if (neutralMovementTypes.has(data.movement_type) && reasons.length === 0) {
        await tx.inventoryValuationMovement.update({
          where: { id: movementRow.id },
          data: { status: 'POSTED_NO_JOURNAL', blockReasons: [] },
        });
        return { status: 'POSTED_NO_JOURNAL', blockReasons: [] };
      }

      const needed = getRequiredInventoryMappings(data.movement_type);
      const mappings = needed.length
        ? await tx.inventoryAccountMapping.findMany({
            where: { mappingKey: { in: needed } },
            include: { account: { select: { id: true, code: true, type: true, status: true } } },
          })
        : [];
      reasons.push(...mappingValidationReasons(data.movement_type, mappings));

      if (!financialMovementTypes.has(data.movement_type) || reasons.length > 0 || movementCost.amount === null) {
        const uniqueReasons = [...new Set(reasons)];
        await tx.inventoryValuationMovement.update({
          where: { id: movementRow.id },
          data: { status: 'BLOCKED', blockReasons: uniqueReasons },
        });
        return { status: 'BLOCKED', blockReasons: uniqueReasons };
      }

      if (existingJournal && existingJournal.eventId !== event.event_id) {
        const conflict = ['A different event is already posted for this movement_id'];
        await tx.inventoryValuationMovement.update({
          where: { id: movementRow.id },
          data: { status: 'BLOCKED', blockReasons: conflict },
        });
        return { status: 'BLOCKED', blockReasons: conflict };
      }

      const postingLines = getPostingLines(event, movementCost.amount, mappings);
      if (postingLines.length !== 2) {
        const missing = ['Required posting account mapping is unavailable'];
        await tx.inventoryValuationMovement.update({
          where: { id: movementRow.id },
          data: { status: 'BLOCKED', blockReasons: missing },
        });
        return { status: 'BLOCKED', blockReasons: missing };
      }

      const journal = existingJournal ?? await createJournalEntryInTransaction({
        referenceType: 'INVENTORY_VALUATION_MOVEMENT',
        referenceId: data.movement_id,
        eventId: event.event_id,
        narration: `Inventory valuation movement ${data.movement_id} (${data.movement_type})`,
        entryDate: data.occurred_at,
        lines: postingLines,
      }, tx);

      await tx.inventoryValuationMovement.update({
        where: { id: movementRow.id },
        data: { status: 'POSTED', blockReasons: [], journalEntryId: journal.id },
      });
      return { status: 'POSTED', blockReasons: [] };
    }, { isolationLevel: 'Serializable' });
  }

  async replayBlocked(limit = 100): Promise<{ scanned: number; posted: number; stillBlocked: number }> {
    const blocked = await this.db.inventoryValuationMovement.findMany({
      where: { status: 'BLOCKED' },
      orderBy: { occurredAt: 'asc' },
      take: Math.max(1, Math.min(500, limit)),
      select: { rawPayload: true },
    });
    let posted = 0;
    for (const row of blocked) {
      const result = await this.process(row.rawPayload);
      if (result.status === 'POSTED' || result.status === 'POSTED_NO_JOURNAL') posted += 1;
    }
    return { scanned: blocked.length, posted, stillBlocked: blocked.length - posted };
  }

  async getAccountMappings() {
    const mappings = await this.db.inventoryAccountMapping.findMany({
      include: { account: { select: { id: true, code: true, name: true, type: true, status: true } } },
      orderBy: { mappingKey: 'asc' },
    });
    return (Object.keys(mappingTypes) as InventoryMappingKey[]).map((mappingKey) => {
      const mapping = mappings.find((candidate) => candidate.mappingKey === mappingKey);
      const valid = Boolean(mapping)
        && mapping!.account.type === mappingTypes[mappingKey]
        && mapping!.account.status === 'ACTIVE';
      return {
        mappingKey,
        requiredAccountType: mappingTypes[mappingKey],
        configured: Boolean(mapping),
        valid,
        account: mapping?.account ?? null,
        approvedByUserId: mapping?.approvedByUserId ?? null,
      };
    });
  }

  async setAccountMapping(mappingKey: InventoryMappingKey, accountId: string, approvedByUserId: string) {
    const expectedType = mappingTypes[mappingKey];
    if (!expectedType) throw new Error('Unsupported inventory account mapping key');
    const account = await this.db.account.findUnique({ where: { id: accountId } });
    if (!account || account.status !== 'ACTIVE' || account.type !== expectedType) {
      throw new Error(`Mapping ${mappingKey} must reference an existing active ${expectedType} account`);
    }
    return this.db.inventoryAccountMapping.upsert({
      where: { mappingKey },
      create: { mappingKey, accountId, approvedByUserId },
      update: { accountId, approvedByUserId },
      include: { account: { select: { id: true, code: true, name: true, type: true, status: true } } },
    });
  }

  async getReport(params: {
    shopIds: string[] | null;
    from?: Date;
    to?: Date;
    warehouseId?: string;
    sku?: string;
    historyPage?: number;
    historyPageSize?: number;
  }): Promise<InventoryValuationReport> {
    const scope = params.shopIds ? { shopId: { in: params.shopIds } } : {};
    const filters = {
      ...scope,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.sku ? {
        OR: [
          { sku: { contains: params.sku, mode: 'insensitive' as const } },
          { productId: { contains: params.sku, mode: 'insensitive' as const } },
        ],
      } : {}),
    };
    const to = params.to;
    const eventRows = await this.db.inventoryValuationMovement.findMany({
      where: {
        ...filters,
        ...(params.from || to ? {
          occurredAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(to ? { lte: to } : {}),
          },
        } : {}),
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        movementType: true,
        status: true,
        totalCostMmk: true,
        inventoryValueMmk: true,
        occurredAt: true,
        shopId: true,
        warehouseId: true,
        productId: true,
        sku: true,
        variantId: true,
        onHandQty: true,
        averageUnitCostMmk: true,
        valuationVersion: true,
        eventId: true,
        blockReasons: true,
      },
    });

    const historyRows = params.from
      ? await this.db.inventoryValuationMovement.findMany({
          where: {
            ...filters,
            occurredAt: { lt: params.from },
          },
          orderBy: { occurredAt: 'asc' },
          select: {
            movementType: true,
            status: true,
            totalCostMmk: true,
            inventoryValueMmk: true,
            occurredAt: true,
            shopId: true,
            warehouseId: true,
            productId: true,
            sku: true,
            variantId: true,
            onHandQty: true,
            averageUnitCostMmk: true,
            valuationVersion: true,
            eventId: true,
            blockReasons: true,
          },
        })
      : [];

    const historyPage = Math.max(1, params.historyPage ?? 1);
    const historyPageSize = Math.max(1, Math.min(100, params.historyPageSize ?? 20));
    const sourceWhere = {
      ...(params.shopIds ? { shopId: { in: params.shopIds } } : { shopId: { not: null } }),
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.sku ? {
        OR: [
          { sku: { contains: params.sku, mode: 'insensitive' as const } },
          { productId: { contains: params.sku, mode: 'insensitive' as const } },
        ],
      } : {}),
      ...(params.from || to ? {
        occurredAt: {
          ...(params.from ? { gte: params.from } : {}),
          ...(to ? { lte: to } : {}),
        },
      } : {}),
    };
    const [sourceHistoryRows, sourceHistoryCount] = await Promise.all([
      this.db.warehouseInventorySourceEvent.findMany({
        where: sourceWhere,
        orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }, { lineIndex: 'asc' }],
        skip: (historyPage - 1) * historyPageSize,
        take: historyPageSize,
      }),
      this.db.warehouseInventorySourceEvent.count({ where: sourceWhere }),
    ]);

    let totalInventoryQuantity: number | null = null;
    let totalAvailableQuantity: number | null = null;
    let quantityAsOf: string | null = null;
    if (!params.warehouseId) {
      const stockScope = {
        ...(params.shopIds ? { shopId: { in: params.shopIds } } : { shopId: { not: null } }),
        eventType: 'inventory.updated',
        ...(to ? { occurredAt: { lte: to } } : {}),
        ...(params.sku ? {
          OR: [
            { sku: { contains: params.sku, mode: 'insensitive' as const } },
            { productId: { contains: params.sku, mode: 'insensitive' as const } },
          ],
        } : {}),
      };
      const stockRows = await this.db.warehouseInventorySourceEvent.findMany({
        where: stockScope,
        orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
        select: {
          shopId: true,
          productId: true,
          onHandQty: true,
          availableQty: true,
          occurredAt: true,
        },
      });
      const latestStockByProduct = new Map<string, typeof stockRows[number]>();
      for (const row of stockRows) {
        if (!row.shopId || !row.productId) continue;
        const key = `${row.shopId}\u0000${row.productId}`;
        if (!latestStockByProduct.has(key)) latestStockByProduct.set(key, row);
      }
      if (latestStockByProduct.size) {
        const latest = [...latestStockByProduct.values()];
        totalInventoryQuantity = latest.every((row) => row.onHandQty !== null)
          ? latest.reduce((sum, row) => sum + (fromDecimal(row.onHandQty) ?? 0), 0)
          : null;
        totalAvailableQuantity = latest.every((row) => row.availableQty !== null)
          ? latest.reduce((sum, row) => sum + (fromDecimal(row.availableQty) ?? 0), 0)
          : null;
        quantityAsOf = new Date(Math.max(...latest.map((row) => row.occurredAt.getTime()))).toISOString();
      }
    }

    const movementHistory = sourceHistoryRows.map((row) => ({
      sourceEventId: row.eventId,
      eventType: row.eventType,
      movementType: row.movementType,
      sourceDocumentId: row.sourceDocumentId,
      sourceDocumentType: row.sourceDocumentType,
      correlationId: row.correlationId,
      productId: row.productId,
      sku: row.sku,
      variantId: row.variantId,
      shopId: row.shopId,
      warehouseId: row.warehouseId,
      quantity: fromDecimal(row.quantity),
      availableQty: fromDecimal(row.availableQty),
      onHandQty: fromDecimal(row.onHandQty),
      reportedUnitCost: fromDecimal(row.reportedUnitCost),
      currency: row.currency,
      occurredAt: row.occurredAt.toISOString(),
      blockReason: row.blockReason,
    }));
    const allRows = [...historyRows, ...eventRows];
    const keyOf = (row: typeof allRows[number]) =>
      `${row.shopId}\u0000${row.warehouseId}\u0000${row.productId}\u0000${row.variantId}`;
    const hasUntrustedValuation = (row: typeof allRows[number]) => row.blockReasons.some((reason) =>
      reason.startsWith('Valuation version ')
      || reason.startsWith('inventory_value_mmk does not reconcile')
      || reason.startsWith('quantity ')
      || reason.startsWith('on_hand_qty ')
      || reason.startsWith('Opening inventory is unknown')
      || reason.startsWith('SKU-level quantity roll-forward mismatch')
      || reason.startsWith('Running WAC cannot be verified')
      || reason.startsWith('Running inventory value/WAC mismatch')
      || reason.startsWith('INITIAL_BALANCE '),
    );
    const latestByKey = new Map<string, typeof allRows[number]>();
    for (const row of allRows) {
      if (hasUntrustedValuation(row)) continue;
      const key = keyOf(row);
      const existing = latestByKey.get(key);
      if (!existing || row.occurredAt > existing.occurredAt) latestByKey.set(key, row);
    }
    const openingRows = new Map<string, typeof allRows[number]>();
    for (const row of historyRows) {
      if (hasUntrustedValuation(row)) continue;
      const key = keyOf(row);
      const existing = openingRows.get(key);
      if (!existing || row.occurredAt > existing.occurredAt) openingRows.set(key, row);
    }
    const mappings = await this.getAccountMappings();
    const mappingMissing = mappings.some((mapping) => !mapping.valid);
    const blocked = allRows.some((row) => row.status === 'BLOCKED');
    const coverageFrom = config.inventoryValuationCoverageFrom || null;
    const missingComponents: string[] = [];
    if (!coverageFrom) missingComponents.push('sourceCoverageStartNotConfigured');
    else {
      const coverageDate = new Date(coverageFrom);
      if (Number.isNaN(coverageDate.getTime())) missingComponents.push('sourceCoverageStartInvalid');
      else if (params.from && coverageDate > params.from) {
        missingComponents.push('requestedPeriodStartsBeforeSourceCoverage');
      }
    }
    if (params.from && openingRows.size === 0) missingComponents.push('openingStockNotFoundBeforePeriod');
    if (mappingMissing) missingComponents.push('financeAccountMappingsMissingOrInvalid');
    if (blocked) missingComponents.push('blockedOrUnverifiedInventoryEvents');
    const sumPostedType = (type: string): number | null => {
      const candidates = eventRows.filter((row) => row.movementType === type);
      if (candidates.length === 0 || candidates.some((row) => row.status !== 'POSTED' || row.totalCostMmk === null)) {
        return null;
      }
      return roundMoney(candidates.reduce((sum, row) => sum + (fromDecimal(row.totalCostMmk) ?? 0), 0));
    };
    const openingKnown = !params.from || (
      openingRows.size > 0 && [...openingRows.values()].every((row) => row.inventoryValueMmk !== null)
    );
    const closingKnown = latestByKey.size > 0
      && [...latestByKey.values()].every((row) => row.inventoryValueMmk !== null);
    const openingValue = params.from
      ? (openingKnown ? roundMoney([...openingRows.values()].reduce((sum, row) => sum + (fromDecimal(row.inventoryValueMmk) ?? 0), 0)) : null)
      : null;
    const closingValue = closingKnown
      ? roundMoney([...latestByKey.values()].reduce((sum, row) => sum + (fromDecimal(row.inventoryValueMmk) ?? 0), 0))
      : null;
    const valuation = [...latestByKey.values()].map((row) => ({
      sku: row.sku,
      productId: row.productId,
      variantId: row.variantId,
      warehouseId: row.warehouseId,
      shopId: row.shopId,
      onHandQty: fromDecimal(row.onHandQty) ?? 0,
      averageUnitCostMmk: fromDecimal(row.averageUnitCostMmk),
      inventoryValueMmk: fromDecimal(row.inventoryValueMmk),
      valuationVersion: row.valuationVersion,
      asOf: row.occurredAt.toISOString(),
    }));

    const purchaseCost = sumPostedType('PURCHASE_RECEIVED');
    const purchaseReturns = sumPostedType('PURCHASE_RETURNED');
    const cogs = sumPostedType('SALE_ISSUED');
    const inventoryValue = closingKnown ? closingValue : null;
    const inventoryAsOf = params.to?.toISOString()
      ?? (latestByKey.size > 0
        ? new Date(Math.max(...[...latestByKey.values()].map((row) => row.occurredAt.getTime()))).toISOString()
        : null);
    if (params.from && !openingKnown) missingComponents.push('openingStockValueUnknown');
    if (inventoryValue === null) missingComponents.push('inventoryValueSnapshotUnavailable');
    if (purchaseCost === null) missingComponents.push('purchaseCostSourceCoverageOrCostMissing');
    // The v1 envelope has a movement cost but no independent purchase-vs-landed-cost split.
    missingComponents.push('landedCostSourceUnavailable');
    if (cogs === null) missingComponents.push('cogsSourceCoverageOrCostMissing');
    if (purchaseReturns === null) missingComponents.push('purchaseReturnSourceCoverageOrCostMissing');
    missingComponents.push('saleReturnEventsNotAvailableFromSource');
    missingComponents.push('damagedStockEventsNotAvailableFromSource');
    missingComponents.push('inventoryAdjustmentEventsNotAvailableFromSource');
    // No independent inventory subledger comparison is available; internal WAC arithmetic alone
    // is not a reconciliation variance.
    missingComponents.push('independentLedgerReconciliationSourceUnavailable');
    if (valuation.some((row) => row.inventoryValueMmk === null || row.averageUnitCostMmk === null)) {
      missingComponents.push('skuValuationCostMissing');
    }

    return {
      complete: missingComponents.length === 0,
      missingComponents: [...new Set(missingComponents)],
      coverageFrom,
      totalInventoryQuantity,
      totalAvailableQuantity,
      quantityAsOf,
      metrics: {
        inventoryValueMmk: inventoryValue,
        purchaseCostMmk: purchaseCost,
        landedCostMmk: null,
        cogsMmk: cogs,
        purchaseReturnsMmk: purchaseReturns,
        salesReturnsMmk: null,
        damagedStockValueMmk: null,
        inventoryAdjustmentsMmk: null,
        openingInventoryValueMmk: openingValue,
        reconciliationVarianceMmk: null,
      },
      inventoryAsOf,
      valuation,
      movementHistory: {
        items: movementHistory,
        page: historyPage,
        pageSize: historyPageSize,
        total: sourceHistoryCount,
        totalPages: Math.ceil(sourceHistoryCount / historyPageSize),
      },
    };
  }
}

export function getInventoryMappingAccountTypes(): Record<InventoryMappingKey, string> {
  return { ...mappingTypes };
}
