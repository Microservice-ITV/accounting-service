import test from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type InvoiceNotificationEvent,
  InvoiceProjectionService,
  normalizeInvoiceNotificationEvent,
} from '../services/invoice-projection.service.js';
import { InvoiceProjectionRepository } from './invoice-projection.repository.js';

type InboxRecord = {
  eventId: string;
  invoiceId: string;
  eventType: string;
  payloadHash: string;
};

type ProjectionRecord = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  shopId: string;
  customerId: string;
  invoiceDate: Date;
  paymentMethod: string | null;
  observedStatus: string;
  currency: string;
  invoiceTotal: { toString(): string };
  statusEventId: string;
  statusEventType: string;
  statusObservedAt: Date;
};

class TransactionalMemoryDatabase {
  inbox = new Map<string, InboxRecord>();
  projections = new Map<string, ProjectionRecord>();

  readonly invoiceEventInbox = {
    findUnique: async ({ where }: { where: { eventId: string } }) =>
      this.inbox.get(where.eventId) ?? null,
  };

  readonly $transaction = async <T>(
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    const inbox = new Map(this.inbox);
    const projections = new Map(this.projections);
    const transaction = this.createTransaction(inbox, projections);
    const result = await work(transaction);
    this.inbox = inbox;
    this.projections = projections;
    return result;
  };

  private createTransaction(
    inbox: Map<string, InboxRecord>,
    projections: Map<string, ProjectionRecord>,
  ): Prisma.TransactionClient {
    return {
      invoiceEventInbox: {
        findUnique: async ({ where }: { where: { eventId: string } }) =>
          inbox.get(where.eventId) ?? null,
        create: async ({ data }: { data: InboxRecord }) => {
          inbox.set(data.eventId, data);
          return data;
        },
      },
      invoiceProjection: {
        findUnique: async ({ where }: { where: { invoiceId: string } }) =>
          projections.get(where.invoiceId) ?? null,
        create: async ({ data }: { data: Omit<ProjectionRecord, 'id' | 'invoiceTotal'> & { invoiceId: string; invoiceTotal: string } }) => {
          const record: ProjectionRecord = {
            ...data,
            id: `projection-${projections.size + 1}`,
            invoiceTotal: { toString: () => data.invoiceTotal },
          };
          projections.set(record.invoiceId, record);
          return record;
        },
        update: async ({ where, data }: {
          where: { invoiceId: string };
          data: Partial<Omit<ProjectionRecord, 'id' | 'invoiceTotal'>> & { invoiceTotal?: string };
        }) => {
          const current = projections.get(where.invoiceId);
          if (!current) throw new Error('Projection not found');
          const record: ProjectionRecord = {
            ...current,
            ...data,
            invoiceTotal: { toString: () => data.invoiceTotal ?? current.invoiceTotal.toString() },
          };
          projections.set(where.invoiceId, record);
          return record;
        },
      },
    } as unknown as Prisma.TransactionClient;
  }
}

function notification(
  type: 'invoice.generated' | 'invoice.paid',
  eventId: string,
  overrides: { invoiceId?: string; shopId?: string; status?: string } = {},
): InvoiceNotificationEvent {
  return normalizeInvoiceNotificationEvent({
    event_id: eventId,
    event: type,
    version: 'v1',
    timestamp: '2026-10-30T16:30:00.000Z',
    producer: 'invoice-service',
    data: {
      invoice_id: overrides.invoiceId ?? 'invoice-1',
      invoice_number: 'INV-001',
      order_id: 'order-1',
      shop_id: overrides.shopId ?? 'shop-1',
      customer_id: 'customer-1',
      invoice_date: '2026-10-30T16:00:00.000Z',
      payment_method: 'CARD',
      payment_status: overrides.status ?? (type === 'invoice.paid' ? 'PAID' : 'UNPAID'),
      currency: 'MMK',
      grand_total: '100.00',
    },
  });
}

function serviceFor(database: TransactionalMemoryDatabase) {
  const repository = new InvoiceProjectionRepository(database as unknown as PrismaClient);
  return new InvoiceProjectionService(repository);
}

test('projection and inbox are committed in one transaction and duplicate event stays idempotent', async () => {
  const database = new TransactionalMemoryDatabase();
  const service = serviceFor(database);
  const generated = notification('invoice.generated', 'event-generated');

  assert.equal((await service.processEvent(generated)).result, 'CREATED');
  assert.equal((await service.processEvent(generated)).result, 'DUPLICATE');
  assert.equal(database.inbox.size, 1);
  assert.equal(database.projections.size, 1);
});

test('PAID status remains when a distinct late invoice.generated event arrives', async () => {
  const database = new TransactionalMemoryDatabase();
  const service = serviceFor(database);

  await service.processEvent(notification('invoice.paid', 'event-paid'));
  const lateGenerated = await service.processEvent(notification(
    'invoice.generated',
    'event-generated-late',
    { status: 'UNPAID' },
  ));

  assert.equal(lateGenerated.result, 'STALE_STATUS_IGNORED');
  assert.equal(database.projections.get('invoice-1')?.observedStatus, 'PAID');
  assert.equal(database.inbox.size, 2);
});

test('conflicting invoice identity rolls back the inbox write', async () => {
  const database = new TransactionalMemoryDatabase();
  const service = serviceFor(database);

  await service.processEvent(notification('invoice.generated', 'event-generated'));
  await assert.rejects(
    service.processEvent(notification('invoice.paid', 'event-paid', { shopId: 'shop-other' })),
    /conflicting snapshot identity/,
  );

  assert.equal(database.inbox.has('event-paid'), false);
  assert.equal(database.projections.get('invoice-1')?.shopId, 'shop-1');
});
