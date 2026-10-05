import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import type { IProfitLossService } from '../interfaces/profit-loss.service.interface.js';
import { profitLossQuerySchema } from '../dto/profit-loss.dto.js';

const statusForError = (message: string) =>
  /unauthenticated|unauthorized|token/i.test(message) ? 401
    : message.startsWith('Forbidden:') || message.includes('authorized shop') ? 403 : 500;

type ProfitLossRequest = Request & { auth?: AuthenticatedExpenseContext };

export class ProfitLossController {
  constructor(private readonly profitLossService: IProfitLossService) {}

  async getProfitLoss(req: ProfitLossRequest, res: Response) {
    try {
      const context = req.auth ?? null;
      if (!context) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const query = profitLossQuerySchema.parse(req.query);
      return res.json(await this.profitLossService.getProfitLoss(query, context));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid Profit & Loss query' });
      }
      const message = error instanceof Error ? error.message : 'Unable to generate report';
      const status = statusForError(message);
      return res.status(status).json({
        error: status === 500 ? 'Unable to generate report' : message,
      });
    }
  }
}
