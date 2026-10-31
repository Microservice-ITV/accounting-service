import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type {
  IInvoiceProjectionRepository,
  InvoiceNotificationEvent,
  InvoiceProjectionFilters,
  InvoiceProjectionSnapshot,
} from '../services/invoice-projection.service.js';

export class InvoiceProjectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceProjectionConflictError';
  }
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toProjectionData(snapshot: InvoiceProjectionSnapshot) {
  return {
    invoiceNumber: snapshot.invoiceNumber,
    orderId: snapshot.orderId,
    shopId: snapshot.shopId,
    customerId: snapshot.customerId,
    invoiceDate: snapshot.invoiceDate,
    paymentMethod: snapshot.paymentMethod,
    observedStatus: snapshot.observedStatus,
    currency: snapshot.currency,
    invoiceTotal: snapshot.invoiceTotal,
    statusEventId: snapshot.statusEventId,
    statusEventType: snapshot.statusEventType,
    statusObservedAt: snapshot.statusObservedAt,
  };
}

function assertStableInvoiceIdentity(
  existing: {
    invoiceNumber: string;
    orderId: string;
    shopId: string;
    customerId: string;
    invoiceDate: Date;
    paymentMethod: string | null;
    currency: string;
    invoiceTotal: { toString(): string };
  },
  incoming: InvoiceProjectionSnapshot,
): void {
  if (
    existing.invoiceNumber !== incoming.invoiceNumber
    || existing.orderId !== incoming.orderId
    || existing.shopId !== incoming.shopId
    || existing.customerId !== incoming.customerId
    || existing.invoiceDate.getTime() !== incoming.invoiceDate.getTime()
    || existing.paymentMethod !== incoming.paymentMethod
    || existing.currency !== incoming.currency
    || Number(existing.invoiceTotal.toString()) !== Number(incoming.invoiceTotal)
  ) {
    throw new InvoiceProjectionConflictError(
      `Invoice ${incoming.invoiceId} was received with conflicting snapshot identity or totals`,
    );
  }
}

export class InvoiceProjectionRepository implements IInvoiceProjectionRepository {
  constructor(private readonly database: PrismaClient = prisma) {}

  async applyEvent(
    event: InvoiceNotificationEvent,
    snapshot: InvoiceProjectionSnapshot,
    payloadHash: string,
  ): Promise<'CREATED' | 'UPDATED' | 'DUPLICATE' | 'STALE_STATUS_IGNORED'> {
    try {
      return await this.database.$transaction(async (tx) => {
        const existingEvent = await tx.invoiceEventInbox.findUnique({
          where: { eventId: event.event_id },
          select: { invoiceId: true, eventType: true, payloadHash: true },
        });
        if (existingEvent) {
          if (
            existingEvent.invoiceId !== snapshot.invoiceId
            || existingEvent.eventType !== event.event
            || existingEvent.payloadHash !== payloadHash
          ) {
            throw new InvoiceProjectionConflictError(
              `Invoice event ${event.event_id} was reused with a different payload`,
            );
          }
          return 'DUPLICATE';
        }

        await tx.invoiceEventInbox.create({
          data: {
            eventId: event.event_id,
            invoiceId: snapshot.invoiceId,
            eventType: event.event,
            payloadHash,
          },
        });

        const existingProjection = await tx.invoiceProjection.findUnique({
          where: { invoiceId: snapshot.invoiceId },
        });
        if (!existingProjection) {
          await tx.invoiceProjection.create({
            data: {
              invoiceId: snapshot.invoiceId,
              ...toProjectionData(snapshot),
            },
          });
          return 'CREATED';
        }

        assertStableInvoiceIdentity(existingProjection, snapshot);

        if (
          existingProjection.observedStatus === 'PAID'
          && event.event === 'invoice.generated'
          && snapshot.observedStatus !== 'PAID'
        ) {
          return 'STALE_STATUS_IGNORED';
        }

        await tx.invoiceProjection.update({
          where: { invoiceId: snapshot.invoiceId },
          data: toProjectionData(snapshot),
        });
        return 'UPDATED';
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      const competingEvent = await this.database.invoiceEventInbox.findUnique({
        where: { eventId: event.event_id },
        select: { invoiceId: true, eventType: true, payloadHash: true },
      });
      if (!competingEvent) throw error;
      if (
        competingEvent.invoiceId !== snapshot.invoiceId
        || competingEvent.eventType !== event.event
        || competingEvent.payloadHash !== payloadHash
      ) {
        throw new InvoiceProjectionConflictError(
          `Invoice event ${event.event_id} was reused with a different payload`,
        );
      }
      return 'DUPLICATE';
    }
  }

  async list(filters: InvoiceProjectionFilters) {
    const where: Prisma.InvoiceProjectionWhereInput = {
      ...(filters.shopIds ? { shopId: { in: filters.shopIds } } : {}),
      ...(filters.status ? { observedStatus: filters.status } : {}),
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...((filters.invoiceDateFrom || filters.invoiceDateToExclusive)
        ? {
          invoiceDate: {
            ...(filters.invoiceDateFrom ? { gte: filters.invoiceDateFrom } : {}),
            ...(filters.invoiceDateToExclusive ? { lt: filters.invoiceDateToExclusive } : {}),
          },
        }
        : {}),
    };

    const [invoices, total] = await Promise.all([
      this.database.invoiceProjection.findMany({
        where,
        orderBy: [{ invoiceDate: 'desc' }, { invoiceId: 'asc' }],
        skip: filters.offset,
        take: filters.limit,
        select: {
          invoiceId: true,
          invoiceNumber: true,
          orderId: true,
          shopId: true,
          customerId: true,
          invoiceDate: true,
          paymentMethod: true,
          observedStatus: true,
          currency: true,
          invoiceTotal: true,
          statusObservedAt: true,
        },
      }),
      this.database.invoiceProjection.count({ where }),
    ]);

    return {
      invoices: invoices.map((invoice) => ({
        ...invoice,
        invoiceTotal: invoice.invoiceTotal.toString(),
      })),
      total,
    };
  }
}
