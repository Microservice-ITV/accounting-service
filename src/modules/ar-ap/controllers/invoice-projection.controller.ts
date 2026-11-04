import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import {
  InvoiceProjectionAuthorizationError,
  InvoiceProjectionService,
} from '../services/invoice-projection.service.js';

type InvoiceProjectionRequest = Request & { auth?: AuthenticatedExpenseContext };

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invoice date filters must be valid YYYY-MM-DD dates');

const querySchema = z.object({
  shopId: z.string().trim().min(1).optional(),
  status: z.enum(['UNPAID', 'PENDING_VERIFICATION', 'PAID', 'REJECTED', 'VOID', 'REFUNDED']).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a three-letter code').optional(),
  invoiceDateFrom: dateOnly.optional(),
  invoiceDateTo: dateOnly.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).superRefine((query, context) => {
  if (query.invoiceDateFrom && query.invoiceDateTo && query.invoiceDateFrom > query.invoiceDateTo) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invoiceDateFrom'],
      message: 'invoiceDateFrom must not be after invoiceDateTo',
    });
  }
});

export class InvoiceProjectionController {
  constructor(private readonly service: InvoiceProjectionService) {}

  async list(req: InvoiceProjectionRequest, res: Response) {
    try {
      const query = querySchema.parse(req.query);
      return res.json(await this.service.list(req.auth ?? null, {
        requestedShopId: query.shopId,
        status: query.status,
        currency: query.currency,
        invoiceDateFrom: query.invoiceDateFrom,
        invoiceDateTo: query.invoiceDateTo,
        limit: query.limit,
        offset: query.offset,
      }));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid invoice projection query' });
      }
      if (error instanceof InvoiceProjectionAuthorizationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('[INVOICE_PROJECTION_QUERY_FAILED]', error);
      return res.status(500).json({ error: 'Unable to load invoice snapshots' });
    }
  }
}
