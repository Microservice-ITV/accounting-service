import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { accountSchema } from '../dto/account.dto.js';
import { AccountApplicationError } from '../errors/account.error.js';
import type { IAccountService } from '../interfaces/account.service.interface.js';

export class AccountController {
  constructor(private readonly accountService: IAccountService) {}

  list = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.accountService.list());
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to fetch accounts',
      });
    }
  };

  getByCode = async (req: Request<{ code: string }>, res: Response) => {
    try {
      const account = await this.accountService.getByCode(req.params.code);
      return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Account lookup failed',
      });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      return res.status(201).json(await this.accountService.create(accountSchema.parse(req.body)));
    } catch (error) {
      return this.sendMutationError(res, error, 'Invalid account payload');
    }
  };

  update = async (req: Request<{ code: string }>, res: Response) => {
    try {
      const account = await this.accountService.update(
        req.params.code,
        accountSchema.parse(req.body),
      );
      return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
    } catch (error) {
      return this.sendMutationError(res, error, 'Invalid account payload');
    }
  };

  toggleStatus = async (req: Request<{ code: string }>, res: Response) => {
    try {
      const account = await this.accountService.toggleStatus(req.params.code);
      return account ? res.json(account) : res.status(404).json({ error: 'Account not found' });
    } catch (error) {
      if (error instanceof AccountApplicationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to update account status',
      });
    }
  };

  private sendMutationError(res: Response, error: unknown, fallback: string) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: error.issues[0]?.message ?? fallback });
    }
    if (error instanceof AccountApplicationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(400).json({ error: error instanceof Error ? error.message : fallback });
  }
}
