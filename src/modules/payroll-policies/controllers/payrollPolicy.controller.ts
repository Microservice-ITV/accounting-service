import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  compactPolicyInput,
  policyBodySchema,
  policyQuerySchema,
  policyUpdateSchema,
  toPolicyInput,
  type PayrollPolicyInput,
} from '../dto/payrollPolicy.dto.js';
import type { IPayrollPolicyService } from '../interfaces/payrollPolicy.service.interface.js';
import {
  payrollPaginated,
  payrollResponse,
  sendPayrollError,
  sendPayrollNotFound,
} from '../../payroll-shared/payrollSerialization.js';

const sendValidationError = (
  res: Response,
  error: unknown,
  fallback: string,
) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ message: error.issues[0]?.message ?? fallback });
  }
  if (error instanceof Error && /unique|already exists/i.test(error.message)) {
    return res.status(409).json({ message: 'Payroll policy reference already exists' });
  }
  return sendPayrollError(res, error, fallback);
};

const pathParam = (value: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

export class PayrollPolicyController {
  constructor(private readonly payrollPolicyService: IPayrollPolicyService) {}

  async list(req: Request, res: Response) {
    try {
      const query = policyQuerySchema.parse(req.query);
      const { data, meta } = await this.payrollPolicyService.list({
        shopId: query.shop_id,
        isActive: query.is_active,
        page: query.page,
        perPage: query.per_page,
      });
      return res.json(
        payrollResponse({
          payroll_policies: payrollPaginated(data, meta.total, meta.page, meta.perPage),
        }),
      );
    } catch (error) {
      return sendValidationError(res, error, 'Invalid query parameters');
    }
  }

  async getActive(req: Request, res: Response) {
    try {
      const shopId = typeof req.query.shop_id === 'string' ? req.query.shop_id : null;
      const policy = await this.payrollPolicyService.getActiveForShop(shopId);
      return policy
        ? res.json(payrollResponse({ payroll_policy: policy }))
        : sendPayrollNotFound(res, 'No active payroll policy found');
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to fetch active policy');
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const policy = await this.payrollPolicyService.getById(pathParam(req.params.id));
      return policy
        ? res.json(payrollResponse({ payroll_policy: policy }))
        : sendPayrollNotFound(res, 'Payroll policy not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Policy lookup failed');
    }
  }

  async create(req: Request, res: Response) {
    try {
      const body = policyBodySchema.parse(req.body);
      const policy = await this.payrollPolicyService.create(
        toPolicyInput(body) as PayrollPolicyInput,
      );
      return res.status(201).json(payrollResponse({ payroll_policy: policy }));
    } catch (error) {
      return sendValidationError(res, error, 'Invalid payroll policy payload');
    }
  }

  async update(req: Request, res: Response) {
    try {
      const body = policyUpdateSchema.parse(req.body);
      const policy = await this.payrollPolicyService.update(
        pathParam(req.params.id),
        compactPolicyInput(toPolicyInput(body)),
      );
      return policy
        ? res.json(payrollResponse({ payroll_policy: policy }))
        : sendPayrollNotFound(res, 'Payroll policy not found');
    } catch (error) {
      return sendValidationError(res, error, 'Invalid payroll policy payload');
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const deleted = await this.payrollPolicyService.delete(pathParam(req.params.id));
      return deleted
        ? res.json(payrollResponse({ message: 'Payroll policy deleted' }))
        : sendPayrollNotFound(res, 'Payroll policy not found');
    } catch (error) {
      return sendPayrollError(res, error, 'Failed to delete policy');
    }
  }
}
