import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  readPayrollActor,
  runBodySchema,
  runQuerySchema,
  toRunInput,
} from '../dto/payrollRun.dto.js';
import type { IPayrollRunService } from '../interfaces/payrollRun.service.interface.js';
import {
  payrollPaginated,
  payrollResponse,
  sendPayrollError,
  sendPayrollNotFound,
} from '../../payroll-shared/payrollSerialization.js';

const sendValidationError = (res: Response, error: unknown, fallback: string) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ message: error.issues[0]?.message ?? fallback });
  }
  if (error instanceof Error && /unique|already exists/i.test(error.message)) {
    return res.status(409).json({ message: 'Payroll run reference already exists' });
  }
  return sendPayrollError(res, error, fallback);
};

const pathParam = (value: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

export class PayrollRunController {
  constructor(private readonly payrollRunService: IPayrollRunService) {}

  async list(req: Request, res: Response) {
    try {
      const query = runQuerySchema.parse(req.query);
      const { data, meta } = await this.payrollRunService.list({
        shopId: query.shop_id,
        status: query.status,
        policyId: query.policy_id,
        from: query.from,
        to: query.to,
        search: query.search,
        page: query.page,
        perPage: query.per_page,
      });
      return res.json(
        payrollResponse({
          payroll_runs: payrollPaginated(data, meta.total, meta.page, meta.perPage),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Invalid query parameters');
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const run = await this.payrollRunService.getById(pathParam(req.params.id));
      return run
        ? res.json(payrollResponse({ payroll_run: run }))
        : sendPayrollNotFound(res, 'Payroll run not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Payroll run lookup failed');
    }
  }

  async create(req: Request, res: Response) {
    try {
      const body = runBodySchema.parse(req.body);
      const run = await this.payrollRunService.create(toRunInput(body));
      return res.status(201).json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendValidationError(res, error, 'Invalid payroll run payload');
    }
  }

  async calculate(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.calculate(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Calculation failed');
    }
  }

  async submit(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.submitForReview(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Submit failed');
    }
  }

  async approve(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.approve(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
        payload.comment,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Approval failed');
    }
  }

  async reject(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.reject(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
        payload.comment,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Rejection failed');
    }
  }

  async pay(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.markPaid(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Mark as paid failed');
    }
  }

  async voidRun(req: Request, res: Response) {
    try {
      const payload = readPayrollActor(req.body);
      const run = await this.payrollRunService.voidRun(
        pathParam(req.params.id),
        payload.actorId,
        payload.actorName,
        payload.reason ?? payload.comment,
      );
      return res.json(payrollResponse({ payroll_run: run }));
    } catch (error) {
      return sendPayrollError(res, error, 'Void failed');
    }
  }
}
