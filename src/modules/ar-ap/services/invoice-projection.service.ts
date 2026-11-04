import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProfitLossAuthorizationPolicy } from '../../profit-loss/policies/profit-loss-authorization.policy.js';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';

const invoiceStatuses = [
  'UNPAID',
  'PENDING_VERIFICATION',
  'PAID',
  'REJECTED',
  'VOID',
  'REFUNDED',
] as const;

const dateTime = z.string().datetime({ offset: true });
const decimalAmount = z.string().regex(/^\d+(?:\.\d{1,2})?$/);

const invoiceNotificationSchema = z.object({
  event_id: z.string().trim().min(1),
  event: z.enum(['invoice.generated', 'invoice.paid']),
  version: z.literal('v1'),
  timestamp: dateTime,
  producer: z.literal('invoice-service'),
  data: z.object({
    invoice_id: z.string().trim().min(1),
    invoice_number: z.string().trim().min(1),
    order_id: z.string().trim().min(1),
    shop_id: z.string().trim().min(1),
    customer_id: z.string().trim().min(1),
    invoice_date: dateTime,
    payment_method: z.string().nullable(),
    payment_status: z.enum(invoiceStatuses),
    currency: z.string().trim().min(1),
    grand_total: decimalAmount,
  }).passthrough(),
}).passthrough().superRefine((event, context) => {
  const amount = Number(event.data.grand_total);
  if (!Number.isFinite(amount) || amount > 9_999_999_999.99) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data', 'grand_total'],
      message: 'grand_total is outside the supported invoice amount range',
    });
  }
  if (event.event === 'invoice.paid' && event.data.payment_status !== 'PAID') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data', 'payment_status'],
      message: 'invoice.paid must report PAID status',
    });
  }
});

export type InvoiceNotificationEvent = z.infer<typeof invoiceNotificationSchema>;
export type InvoiceProjectionStatus = typeof invoiceStatuses[number];

export type InvoiceProjectionSnapshot = {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  shopId: string;
  customerId: string;
  invoiceDate: Date;
  paymentMethod: string | null;
  observedStatus: InvoiceProjectionStatus;
  currency: string;
  invoiceTotal: string;
  statusEventId: string;
  statusEventType: InvoiceNotificationEvent['event'];
  statusObservedAt: Date;
};

export type InvoiceProjectionScope = { shopIds: string[] | null };

export type InvoiceProjectionFilters = {
  shopIds: string[] | null;
  status?: InvoiceProjectionStatus;
  currency?: string;
  invoiceDateFrom?: Date;
  invoiceDateToExclusive?: Date;
  offset: number;
  limit: number;
};

export interface IInvoiceProjectionRepository {
  applyEvent(
    event: InvoiceNotificationEvent,
    snapshot: InvoiceProjectionSnapshot,
    payloadHash: string,
  ): Promise<'CREATED' | 'UPDATED' | 'DUPLICATE' | 'STALE_STATUS_IGNORED'>;
  list(filters: InvoiceProjectionFilters): Promise<{
    invoices: Array<{
      invoiceId: string;
      invoiceNumber: string;
      orderId: string;
      shopId: string;
      customerId: string;
      invoiceDate: Date;
      paymentMethod: string | null;
      observedStatus: string;
      currency: string;
      invoiceTotal: string;
      statusObservedAt: Date;
    }>;
    total: number;
  }>;
}

export class InvoiceProjectionAuthorizationError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'InvoiceProjectionAuthorizationError';
  }
}

export function normalizeInvoiceNotificationEvent(raw: unknown): InvoiceNotificationEvent {
  return invoiceNotificationSchema.parse(raw);
}

function normalizeAmount(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function eventPayloadHash(event: InvoiceNotificationEvent): string {
  const stableContent = {
    event: event.event,
    eventId: event.event_id,
    invoiceId: event.data.invoice_id,
    invoiceNumber: event.data.invoice_number,
    orderId: event.data.order_id,
    shopId: event.data.shop_id,
    customerId: event.data.customer_id,
    invoiceDate: event.data.invoice_date,
    paymentMethod: event.data.payment_method,
    paymentStatus: event.data.payment_status,
    currency: event.data.currency.trim().toUpperCase(),
    invoiceTotal: normalizeAmount(event.data.grand_total),
  };
  return createHash('sha256').update(JSON.stringify(stableContent)).digest('hex');
}

export function toInvoiceProjectionSnapshot(event: InvoiceNotificationEvent): InvoiceProjectionSnapshot {
  return {
    invoiceId: event.data.invoice_id,
    invoiceNumber: event.data.invoice_number,
    orderId: event.data.order_id,
    shopId: event.data.shop_id,
    customerId: event.data.customer_id,
    invoiceDate: new Date(event.data.invoice_date),
    paymentMethod: event.data.payment_method?.trim() || null,
    observedStatus: event.data.payment_status,
    currency: event.data.currency.trim().toUpperCase(),
    invoiceTotal: normalizeAmount(event.data.grand_total),
    statusEventId: event.event_id,
    statusEventType: event.event,
    statusObservedAt: new Date(event.timestamp),
  };
}

function parseDateBoundary(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invoice date filters must be valid YYYY-MM-DD dates');
  }
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export class InvoiceProjectionService {
  constructor(
    private readonly repository: IInvoiceProjectionRepository,
    private readonly authorizationPolicy = new ProfitLossAuthorizationPolicy(),
  ) {}

  async processEvent(raw: unknown) {
    const event = normalizeInvoiceNotificationEvent(raw);
    return {
      eventId: event.event_id,
      invoiceId: event.data.invoice_id,
      result: await this.repository.applyEvent(
        event,
        toInvoiceProjectionSnapshot(event),
        eventPayloadHash(event),
      ),
    };
  }

  async list(
    context: AuthenticatedExpenseContext | null,
    query: {
      requestedShopId?: string;
      status?: InvoiceProjectionStatus;
      currency?: string;
      invoiceDateFrom?: string;
      invoiceDateTo?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    let scope: InvoiceProjectionScope;
    try {
      scope = this.authorizationPolicy.resolveRequestedShopScope(
        this.authorizationPolicy.resolveSellerShopScope(context),
        query.requestedShopId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Forbidden';
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        && typeof error.statusCode === 'number'
        ? error.statusCode
        : /Unauthenticated/i.test(message) ? 401 : 403;
      throw new InvoiceProjectionAuthorizationError(message, statusCode);
    }

    const invoiceDateFrom = parseDateBoundary(query.invoiceDateFrom, false);
    const invoiceDateToExclusive = parseDateBoundary(query.invoiceDateTo, true);
    if (invoiceDateFrom && invoiceDateToExclusive && invoiceDateFrom >= invoiceDateToExclusive) {
      throw new Error('invoiceDateFrom must not be after invoiceDateTo');
    }

    const result = await this.repository.list({
      shopIds: scope.shopIds,
      status: query.status,
      currency: query.currency?.trim().toUpperCase(),
      invoiceDateFrom,
      invoiceDateToExclusive,
      offset: query.offset ?? 0,
      limit: query.limit ?? 50,
    });

    return {
      invoices: result.invoices.map((invoice) => ({
        ...invoice,
        invoiceDate: invoice.invoiceDate.toISOString(),
        statusObservedAt: invoice.statusObservedAt.toISOString(),
        invoiceTotal: invoice.invoiceTotal,
      })),
      total: result.total,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      scope: scope.shopIds === null
        ? { type: 'platform' }
        : { type: 'authorized_shops', shopIds: scope.shopIds },
      source: 'INVOICE_SERVICE_EVENT_SNAPSHOT',
      financialMeaning: {
        invoiceTotalIsOutstanding: false,
        dueDateAvailable: false,
        paymentAllocationsAvailable: false,
        exactOutstandingAvailable: false,
        invoiceAgingAvailable: false,
        note: 'Invoice total and status are event snapshots only; they are not an outstanding balance or a live invoice status.',
      },
    };
  }
}
