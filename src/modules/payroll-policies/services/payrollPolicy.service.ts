import type { Prisma } from '@prisma/client';
import type {
  PayrollPolicyFilters,
  PayrollPolicyInput,
} from '../dto/payrollPolicy.dto.js';
import type {
  IPayrollPolicyRepository,
  PayrollPolicyRecord,
} from '../interfaces/payrollPolicy.repository.interface.js';
import type {
  IPayrollPolicyService,
  PayrollPolicyListResult,
} from '../interfaces/payrollPolicy.service.interface.js';

function normalizeInput(input: PayrollPolicyInput): PayrollPolicyInput {
  return {
    ...input,
    name: input.name.trim(),
    currency: input.currency?.trim() ?? 'USD',
    standardWorkingDays: input.standardWorkingDays ?? 22,
    standardDailyHours: input.standardDailyHours ?? 8.0,
    overtimeRateMultiplier: input.overtimeRateMultiplier ?? 1.5,
    taxRate: input.taxRate ?? 0.0,
    latenessDeductionPerMin: input.latenessDeductionPerMin ?? 0.0,
    absenceDeductionPerDay: input.absenceDeductionPerDay ?? 0.0,
    unpaidLeaveDeductionPerDay: input.unpaidLeaveDeductionPerDay ?? 0.0,
    isActive: input.isActive ?? true,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
  };
}

function validateInput(input: PayrollPolicyInput) {
  if (!input.name) throw new Error('Policy name is required');
  if (input.standardWorkingDays !== undefined && input.standardWorkingDays < 1) {
    throw new Error('Standard working days must be at least 1');
  }
  if (input.standardDailyHours !== undefined && input.standardDailyHours <= 0) {
    throw new Error('Standard daily hours must be positive');
  }
  if (input.overtimeRateMultiplier !== undefined && input.overtimeRateMultiplier < 0) {
    throw new Error('Overtime rate multiplier cannot be negative');
  }
  if (input.taxRate !== undefined && (input.taxRate < 0 || input.taxRate > 1)) {
    throw new Error('Tax rate must be between 0 and 1');
  }
}

function toPolicyData(
  input: PayrollPolicyInput,
): Prisma.PayrollPolicyUncheckedCreateInput {
  return {
    shopId: input.shopId ?? null,
    name: input.name,
    currency: input.currency,
    standardWorkingDays: input.standardWorkingDays,
    standardDailyHours: input.standardDailyHours,
    overtimeRateMultiplier: input.overtimeRateMultiplier,
    taxRate: input.taxRate,
    latenessDeductionPerMin: input.latenessDeductionPerMin,
    absenceDeductionPerDay: input.absenceDeductionPerDay,
    unpaidLeaveDeductionPerDay: input.unpaidLeaveDeductionPerDay,
    isActive: input.isActive,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  };
}

export class PayrollPolicyService implements IPayrollPolicyService {
  constructor(private readonly repository: IPayrollPolicyRepository) {}

  async list(filters: PayrollPolicyFilters = {}): Promise<PayrollPolicyListResult> {
    const { shopId, isActive, page = 1, perPage = 20 } = filters;
    const where: Prisma.PayrollPolicyWhereInput = {};

    if (shopId) where.shopId = shopId;
    if (isActive !== undefined) where.isActive = isActive;

    const [data, total] = await Promise.all([
      this.repository.findMany(where, (page - 1) * perPage, perPage),
      this.repository.count(where),
    ]);

    return {
      data,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  getById(id: string): Promise<PayrollPolicyRecord | null> {
    return this.repository.findById(id);
  }

  getActiveForShop(shopId: string | null): Promise<PayrollPolicyRecord | null> {
    if (!shopId) return Promise.resolve(null);
    return this.repository.findActiveForShop(shopId, new Date());
  }

  async create(rawInput: PayrollPolicyInput): Promise<PayrollPolicyRecord> {
    const input = normalizeInput(rawInput);
    validateInput(input);
    return this.repository.create(toPolicyData(input));
  }

  async update(
    id: string,
    rawInput: Partial<PayrollPolicyInput>,
  ): Promise<PayrollPolicyRecord | null> {
    const existing = await this.repository.findById(id);
    if (!existing) return null;

    const input = normalizeInput({ ...existing, ...rawInput } as PayrollPolicyInput);
    validateInput(input);

    return this.repository.update(id, toPolicyData(input));
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.repository.findById(id);
    if (!existing) return false;

    await this.repository.delete(id);
    return true;
  }
}
