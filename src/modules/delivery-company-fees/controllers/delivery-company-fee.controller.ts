import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import { deliveryCompanyFeeSchema, deliveryCompanyFeeStatusSchema } from '../dto/delivery-company-fee.dto.js';
import { DeliveryCompanyFeeApplicationError } from '../errors/delivery-company-fee.error.js';
import type { IDeliveryCompanyFeeService } from '../interfaces/delivery-company-fee.service.interface.js';

type AuthenticatedRequest = Request & { auth?: AuthenticatedExpenseContext };

function getAuth(req: Request): AuthenticatedExpenseContext {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) throw new DeliveryCompanyFeeApplicationError('Unauthenticated', 401);
  return auth;
}

function getParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export class DeliveryCompanyFeeController {
  constructor(private readonly service: IDeliveryCompanyFeeService) {}

  private async respond(
    res: Response,
    fallback: string,
    operation: () => Promise<unknown>,
    successStatus = 200,
  ) {
    try {
      const result = await operation();
      return res.status(successStatus).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: error.issues[0]?.message ?? 'Invalid Delivery Company fee rule',
        });
      }
      if (error instanceof DeliveryCompanyFeeApplicationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error('[DELIVERY_COMPANY_FEE_API_ERROR]', error);
      return res.status(500).json({ error: fallback });
    }
  }

  list: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to load Delivery Company fee rules',
    async () => ({ feeRules: await this.service.list(getAuth(req)) }),
  );

  get: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to load Delivery Company fee rule',
    async () => ({ feeRule: await this.service.get(getParam(req.params.id), getAuth(req)) }),
  );

  create: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to create Delivery Company fee rule',
    async () => ({
      feeRule: await this.service.create(deliveryCompanyFeeSchema.parse(req.body), getAuth(req)),
    }),
    201,
  );

  update: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to update Delivery Company fee rule',
    async () => ({
      feeRule: await this.service.update(
        getParam(req.params.id),
        deliveryCompanyFeeSchema.parse(req.body),
        getAuth(req),
      ),
    }),
  );

  setActive: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to update Delivery Company fee rule status',
    async () => {
      const { active } = deliveryCompanyFeeStatusSchema.parse(req.body);
      return { feeRule: await this.service.setActive(getParam(req.params.id), active, getAuth(req)) };
    },
  );

  listActiveConfigurations: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to load active shop Delivery Companies',
    async () => ({
      configurations: await this.service.listActiveConfigurations(getParam(req.params.shopId)),
    }),
  );

  validateConfiguration: RequestHandler = (req, res) => this.respond(
    res,
    'Unable to validate shop Delivery Company',
    async () => {
      const shopId = getParam(req.params.shopId);
      const deliveryCompanyId = getParam(req.params.deliveryCompanyId);
      const valid = await this.service.isActiveConfiguration(shopId, deliveryCompanyId);
      if (!valid) {
        throw new DeliveryCompanyFeeApplicationError(
          'Delivery Company is not configured and active for this shop',
          404,
        );
      }
      return { shopId, deliveryCompanyId };
    },
  );
}
