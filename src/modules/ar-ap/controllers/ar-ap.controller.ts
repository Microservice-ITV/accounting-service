import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import { ArApAuthorizationError, type ArApService } from '../services/ar-ap.service.js';

type ArApRequest = Request & { auth?: AuthenticatedExpenseContext };

const scopeQuerySchema = z.object({
  shopId: z.string().trim().min(1).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a three-letter code').optional(),
});

const transactionQuerySchema = scopeQuerySchema.extend({
  bucket: z.enum(['receivables', 'cod_clearing', 'payables', 'deferred_revenue', 'recorded_receipts']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export class ArApController {
  constructor(private readonly service: ArApService) {}

  async getSummary(req: ArApRequest, res: Response) {
    try {
      const query = scopeQuerySchema.parse(req.query);
      return res.json(await this.service.getSummary(req.auth ?? null, {
        requestedShopId: query.shopId,
        currency: query.currency,
      }));
    } catch (error) {
      return this.handleError(error, res, 'Unable to load AR/AP ledger summary');
    }
  }

  async listTransactions(req: ArApRequest, res: Response) {
    try {
      const query = transactionQuerySchema.parse(req.query);
      return res.json(await this.service.listTransactions(req.auth ?? null, {
        requestedShopId: query.shopId,
        bucket: query.bucket,
        currency: query.currency,
        limit: query.limit,
        offset: query.offset,
      }));
    } catch (error) {
      return this.handleError(error, res, 'Unable to load AR/AP transactions');
    }
  }

  async getTransaction(req: ArApRequest, res: Response) {
    try {
      const query = scopeQuerySchema.parse(req.query);
      const referenceType = Array.isArray(req.params.referenceType)
        ? req.params.referenceType[0]
        : req.params.referenceType;
      const referenceId = Array.isArray(req.params.referenceId)
        ? req.params.referenceId[0]
        : req.params.referenceId;
      return res.json(await this.service.getTransaction(
        req.auth ?? null,
        referenceType ?? '',
        referenceId ?? '',
        query.shopId,
      ));
    } catch (error) {
      return this.handleError(error, res, 'Unable to load AR/AP transaction');
    }
  }

  async getAging(req: ArApRequest, res: Response) {
    try {
      const query = scopeQuerySchema.parse(req.query);
      return res.json(await this.service.getAging(req.auth ?? null, query.shopId));
    } catch (error) {
      return this.handleError(error, res, 'Unable to load AR/AP aging');
    }
  }

  private handleError(error: unknown, res: Response, fallback: string) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid AR/AP query' });
    }
    if (error instanceof ArApAuthorizationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('[AR_AP_REPORT_FAILED]', error);
    return res.status(500).json({ error: fallback });
  }
}