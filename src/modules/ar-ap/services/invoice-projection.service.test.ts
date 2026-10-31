import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type IInvoiceProjectionRepository,
  type InvoiceNotificationEvent,
  type InvoiceProjectionFilters,
  type InvoiceProjectionSnapshot,
  InvoiceProjectionService,
  normalizeInvoiceNotificationEvent,
} from './invoice-projection.service.js';
import { InvoiceProjectionConflictError } from '../repositories/invoice-projection.repository.js';

const shopContext = (shopId: string) => ({
  userId: 'seller-1',
  role: 'shop_admin',
  activeShopId: shopId,
  authorizedShopIds: [shopId],
  shops: [],
});

function event(
  type: 'invoice.generated' | 'invoice.paid' = 'invoice.generated',
  overrides: {
    eventId?: string;
    invoiceId?: string;
    invoiceNumber?: string;
    orderId?: string;
    shopId?: string;
    customerId?: string;
    invoiceDate?: string;
    paymentMethod?: string | null;
    status?: 'UNPAID' | 'PENDING_VERIFICATION' | 'PAID' | 'REJECTED' | 'VOID' | 'REFUNDED';
    currency?: string;
    total?: string;
    timestamp?: string;
  } = {},
): InvoiceNotificationEvent {
  return normalizeInvoiceNotificationEvent({
    event_id: overrides.eventId ?? `invoice:${overrides.invoiceId ?? 'invoice-1'}:${type === 'invoice.generated' ? 'generated' : 'paid'}`,
    event: type,
    version: 'v1',
    timestamp: overrides.timestamp ?? '2026-10-30T16:30:00.000Z',
    producer: 'invoice-service',
    data: {
      invoice_id: overrides.invoiceId ?? 'invoice-1',
      invoice_number: overrides.invoiceNumber ?? 'INV-001',
      order_id: overrides.orderId ?? 'order-1',
      shop_id: overrides.shopId ?? 'shop-1',
      customer_id: overrides.customerId ?? 'customer-1',
      invoice_date: overrides.invoiceDate ?? '2026-10-30T16:00:00.000Z',
      payment_method: overrides.paymentMethod === undefined ? 'CARD' : overrides.paymentMethod,
      payment_status: overrides.status ?? (type === 'invoice.paid' ? 'PAID' : 'UNPAID'),
      currency: overrides.currency ?? 'MMK',
      grand_total: overrides.total ?? '110.00',
    },
  });
}

class MemoryInvoiceProjectionRepository implements IInvoiceProjectionRepository {
  private readonly eventHashes = new Map<string, { invoiceId: string; eventType: string; hash: string }>();
  private readonly projections = new Map<string, InvoiceProjectionSnapshot>();

  async applyEvent(
    incoming: InvoiceNotificationEvent,
    snapshot: InvoiceProjectionSnapshot,
    payloadHash: string,
  ): Promise<'CREATED' | 'UPDATED' | 'DUPLICATE' | 'STALE_STATUS_IGNORED'> {
    const previousEvent = this.eventHashes.get(incoming.event_id);
    if (previousEvent) {
      if (
        previousEvent.invoiceId !== snapshot.invoiceId
        || previousEvent.eventType !== incoming.event
        || previousEvent.hash !== payloadHash
      ) {
        throw new InvoiceProjectionConflictError('Conflicting invoice event identity');
      }
      return 'DUPLICATE';
    }

    this.eventHashes.set(incoming.event_id, {
      invoiceId: snapshot.invoiceId,
      eventType: incoming.event,
      hash: payloadHash,
    });
    const previous = this.projections.get(snapshot.invoiceId);
    if (!previous) {
      this.projections.set(snapshot.invoiceId, snapshot);
      return 'CREATED';
    }
    if (
      previous.observedStatus === 'PAID'
      && incoming.event === 'invoice.generated'
      && snapshot.observedStatus !== 'PAID'
    ) {
      return 'STALE_STATUS_IGNORED';
    }
    this.projections.set(snapshot.invoiceId, snapshot);
    return 'UPDATED';
  }

  async list(filters: InvoiceProjectionFilters) {
    const rows = [...this.projections.values()].filter((row) => (
      (!filters.shopIds || filters.shopIds.includes(row.shopId))
      && (!filters.status || filters.status === row.observedStatus)
      && (!filters.currency || filters.currency === row.currency)
      && (!filters.invoiceDateFrom || row.invoiceDate >= filters.invoiceDateFrom)
      && (!filters.invoiceDateToExclusive || row.invoiceDate < filters.invoiceDateToExclusive)
    ));
    return {
      invoices: rows.slice(filters.offset, filters.offset + filters.limit).map((row) => ({
        ...row,
        invoiceTotal: row.invoiceTotal,
      })),
      total: rows.length,
    };
  }

  get projectionCount() {
    return this.projections.size;
  }
}

test('invoice.generated UNPAID creates an invoice snapshot without an outstanding balance claim', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);

  const processed = await service.processEvent(event());
  const report = await service.list(shopContext('shop-1'));

  assert.equal(processed.result, 'CREATED');
  assert.equal(report.total, 1);
  assert.equal(report.invoices[0]?.invoiceTotal, '110.00');
  assert.equal(report.invoices[0]?.observedStatus, 'UNPAID');
  assert.equal(report.financialMeaning.invoiceTotalIsOutstanding, false);
  assert.equal(report.financialMeaning.paymentAllocationsAvailable, false);
  assert.equal(report.financialMeaning.exactOutstandingAvailable, false);
});

test('invoice.paid updates the snapshot status', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);

  await service.processEvent(event());
  const result = await service.processEvent(event('invoice.paid'));
  const report = await service.list(shopContext('shop-1'), { status: 'PAID' });

  assert.equal(result.result, 'UPDATED');
  assert.equal(report.total, 1);
  assert.equal(report.invoices[0]?.observedStatus, 'PAID');
});

test('duplicate event is idempotent and creates only one projection', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);
  const notification = event();

  assert.equal((await service.processEvent(notification)).result, 'CREATED');
  assert.equal((await service.processEvent(notification)).result, 'DUPLICATE');
  assert.equal(repository.projectionCount, 1);
});

test('late invoice.generated event cannot downgrade a previously observed PAID status', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);

  await service.processEvent(event('invoice.paid'));
  const lateGenerated = await service.processEvent(event('invoice.generated', {
    eventId: 'invoice:invoice-1:generated-late',
    status: 'UNPAID',
    timestamp: '2026-10-30T17:00:00.000Z',
  }));
  const report = await service.list(shopContext('shop-1'));

  assert.equal(lateGenerated.result, 'STALE_STATUS_IGNORED');
  assert.equal(report.invoices[0]?.observedStatus, 'PAID');
});

test('invoice snapshots are isolated by authorized shop and currency filters', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);
  await service.processEvent(event());
  await service.processEvent(event('invoice.generated', {
    invoiceId: 'invoice-2',
    invoiceNumber: 'INV-002',
    orderId: 'order-2',
    shopId: 'shop-2',
    customerId: 'customer-2',
    currency: 'USD',
    total: '25.00',
  }));

  const shopOne = await service.list(shopContext('shop-1'), { currency: 'MMK' });
  const shopTwo = await service.list(shopContext('shop-2'), { currency: 'USD' });
  await assert.rejects(
    service.list(shopContext('shop-1'), { requestedShopId: 'shop-2' }),
    /Forbidden/,
  );

  assert.equal(shopOne.total, 1);
  assert.equal(shopOne.invoices[0]?.shopId, 'shop-1');
  assert.equal(shopOne.invoices[0]?.currency, 'MMK');
  assert.equal(shopTwo.total, 1);
  assert.equal(shopTwo.invoices[0]?.shopId, 'shop-2');
  assert.equal(shopTwo.invoices[0]?.currency, 'USD');
});

test('invoice date filters use inclusive UTC calendar dates', async () => {
  const repository = new MemoryInvoiceProjectionRepository();
  const service = new InvoiceProjectionService(repository);
  await service.processEvent(event());

  const results = await service.list(shopContext('shop-1'), {
    invoiceDateFrom: '2026-10-30',
    invoiceDateTo: '2026-10-30',
  });
  const outsideRange = await service.list(shopContext('shop-1'), {
    invoiceDateFrom: '2026-10-31',
    invoiceDateTo: '2026-10-31',
  });

  assert.equal(results.total, 1);
  assert.equal(outsideRange.total, 0);
});

test('invoice.paid events must report PAID and partial is not an available Invoice Service status', () => {
  assert.throws(() => event('invoice.paid', { status: 'UNPAID' }));
  assert.throws(() => normalizeInvoiceNotificationEvent({
    ...event(),
    data: { ...event().data, payment_status: 'PARTIAL' },
  }));
});
