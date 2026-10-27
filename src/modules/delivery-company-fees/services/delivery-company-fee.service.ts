import { Prisma, type DeliveryCompanyFee } from '@prisma/client';
import { DELIVERY_COMPANY_FEES_CONFIG } from '../../../config/delivery-company-fees.config.js';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';
import type { IDeliveryCompanyFeeRepository } from '../interfaces/delivery-company-fee.repository.interface.js';
import type { IDeliveryCompanyFeeService } from '../interfaces/delivery-company-fee.service.interface.js';
import type { DeliveryCompanyFeeInput } from '../dto/delivery-company-fee.dto.js';
import { DeliveryCompanyFeeApplicationError } from '../errors/delivery-company-fee.error.js';
import { DeliveryCompanyFeeAuthorizationPolicy } from '../policies/delivery-company-fee-authorization.policy.js';

export type DeliveryCompanyValidator = (deliveryCompanyId: string) => Promise<void>;

function isPrismaRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

function toPrismaInput(input: DeliveryCompanyFeeInput) {
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new DeliveryCompanyFeeApplicationError(
      'Effective To must be greater than or equal to Effective From',
      400,
    );
  }

  return {
    shopId: input.shopId,
    deliveryCompanyId: input.deliveryCompanyId,
    chargingBasis: input.chargingBasis,
    amount: new Prisma.Decimal(input.amount),
    currency: input.currency,
    active: input.active,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  };
}

export async function validateActiveDeliveryCompany(deliveryCompanyId: string): Promise<void> {
  const baseUrl = DELIVERY_COMPANY_FEES_CONFIG.shippingServiceBaseUrl;
  if (!baseUrl) {
    throw new DeliveryCompanyFeeApplicationError('SHIPPING_SERVICE_BASE_URL is not configured', 500);
  }

  let response: Response;
  try {
    response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/delivery-companies/${encodeURIComponent(deliveryCompanyId)}`,
      { signal: AbortSignal.timeout(DELIVERY_COMPANY_FEES_CONFIG.shippingValidationTimeoutMs) },
    );
  } catch (error) {
    console.error('[DELIVERY_COMPANY_VALIDATION_ERROR]', error);
    throw new DeliveryCompanyFeeApplicationError(
      'Shipping Service could not validate the Delivery Company',
      500,
    );
  }

  if (response.status === 404) {
    throw new DeliveryCompanyFeeApplicationError('Active Delivery Company not found', 404);
  }
  if (!response.ok) {
    throw new DeliveryCompanyFeeApplicationError(
      `Shipping Service could not validate the Delivery Company (HTTP ${response.status})`,
      500,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.error('[DELIVERY_COMPANY_VALIDATION_ERROR]', error);
    throw new DeliveryCompanyFeeApplicationError(
      'Shipping Service returned an invalid Delivery Company response',
      500,
    );
  }

  const body = payload && typeof payload === 'object' ? payload as { data?: unknown } : {};
  const company = body.data && typeof body.data === 'object'
    ? body.data as { id?: unknown; status?: unknown }
    : {};
  if (company.id !== deliveryCompanyId || company.status !== 'ACTIVE') {
    throw new DeliveryCompanyFeeApplicationError('Active Delivery Company not found', 404);
  }
}

export class DeliveryCompanyFeeService implements IDeliveryCompanyFeeService {
  constructor(
    private readonly repository: IDeliveryCompanyFeeRepository,
    private readonly authorizationPolicy = new DeliveryCompanyFeeAuthorizationPolicy(),
    private readonly validateCompany: DeliveryCompanyValidator = validateActiveDeliveryCompany,
  ) {}

  list(authContext: AuthenticatedExpenseContext) {
    const authorizedShopIds = this.authorizationPolicy.requireShopAssignment(authContext);
    return this.repository.listByShopIds(authorizedShopIds);
  }

  async get(id: string, authContext: AuthenticatedExpenseContext): Promise<DeliveryCompanyFee> {
    const feeRule = await this.repository.findById(id);
    if (!feeRule?.shopId || !feeRule.deliveryCompanyId) {
      throw new DeliveryCompanyFeeApplicationError('Delivery Company fee rule not found', 404);
    }
    this.authorizationPolicy.requireShopAccess(authContext, feeRule.shopId);
    return feeRule;
  }

  async create(input: DeliveryCompanyFeeInput, authContext: AuthenticatedExpenseContext) {
    this.authorizationPolicy.requireShopAccess(authContext, input.shopId);
    const data = toPrismaInput(input);
    await this.validateCompany(input.deliveryCompanyId);
    return this.repository.create(data);
  }

  async update(id: string, input: DeliveryCompanyFeeInput, authContext: AuthenticatedExpenseContext) {
    const existing = await this.repository.findById(id);
    if (!existing?.shopId || !existing.deliveryCompanyId) {
      throw new DeliveryCompanyFeeApplicationError('Delivery Company fee rule not found', 404);
    }
    this.authorizationPolicy.requireShopAccess(authContext, existing.shopId);
    if (input.shopId !== existing.shopId) {
      throw new DeliveryCompanyFeeApplicationError(
        'Shop cannot be changed for an existing Delivery Company configuration',
        403,
      );
    }
    const data = toPrismaInput(input);
    await this.validateCompany(input.deliveryCompanyId);
    try {
      return await this.repository.update(id, data);
    } catch (error) {
      if (isPrismaRecordNotFound(error)) {
        throw new DeliveryCompanyFeeApplicationError('Delivery Company fee rule not found', 404);
      }
      throw error;
    }
  }

  async setActive(id: string, active: boolean, authContext: AuthenticatedExpenseContext) {
    const existing = await this.repository.findById(id);
    if (!existing?.shopId || !existing.deliveryCompanyId) {
      throw new DeliveryCompanyFeeApplicationError('Delivery Company fee rule not found', 404);
    }
    this.authorizationPolicy.requireShopAccess(authContext, existing.shopId);
    try {
      return await this.repository.update(id, { active });
    } catch (error) {
      if (isPrismaRecordNotFound(error)) {
        throw new DeliveryCompanyFeeApplicationError('Delivery Company fee rule not found', 404);
      }
      throw error;
    }
  }

  listActiveConfigurations(shopId: string) {
    return this.repository.listActiveConfigurations(shopId, new Date());
  }

  async isActiveConfiguration(shopId: string, deliveryCompanyId: string): Promise<boolean> {
    return this.repository.hasActiveConfiguration(shopId, deliveryCompanyId, new Date());
  }
}
