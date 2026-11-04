import type { Prisma } from '@prisma/client';
import type {
  PayrollRunFilters,
  PayrollRunInput,
} from '../dto/payrollRun.dto.js';
import type { IPayrollPolicyRepository } from '../../payroll-policies/interfaces/payrollPolicy.repository.interface.js';
import type {
  IPayrollRunRepository,
  PayrollRunRecord,
  PayrollRunWithDetails,
} from '../interfaces/payrollRun.repository.interface.js';
import type {
  IPayrollRunService,
  PayrollRunListResult,
} from '../interfaces/payrollRun.service.interface.js';

function normalizeRunInput(input: PayrollRunInput): PayrollRunInput {
  return {
    ...input,
    periodStart: new Date(input.periodStart),
    periodEnd: new Date(input.periodEnd),
    payDate: input.payDate ? new Date(input.payDate) : null,
  };
}

function validateRunInput(input: PayrollRunInput) {
  if (!input.periodStart) throw new Error('Period start is required');
  if (!input.periodEnd) throw new Error('Period end is required');
  if (new Date(input.periodEnd) < new Date(input.periodStart)) {
    throw new Error('Period end cannot be before period start');
  }
}

function buildReference(periodStart: string | Date) {
  const period = new Date(periodStart).toISOString().slice(0, 7).replace('-', '');
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `PR-${period}-${suffix}`;
}

export class PayrollRunService implements IPayrollRunService {
  constructor(
    private readonly repository: IPayrollRunRepository,
    private readonly payrollPolicyRepository: IPayrollPolicyRepository,
  ) {}

  async list(filters: PayrollRunFilters = {}): Promise<PayrollRunListResult> {
    const { shopId, status, policyId, from, to, search, page = 1, perPage = 20 } = filters;
    const where: Prisma.PayrollRunWhereInput = {};

    if (shopId) where.shopId = shopId;
    if (status) where.status = status;
    if (policyId) where.payrollPolicyId = policyId;
    if (from) where.periodStart = { gte: new Date(from) };
    if (to) where.periodEnd = { lte: new Date(to) };
    if (search) where.reference = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.repository.findMany(where, (page - 1) * perPage, perPage),
      this.repository.count(where),
    ]);

    return {
      data,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  getById(id: string): Promise<PayrollRunWithDetails | null> {
    return this.repository.findById(id);
  }

  async create(rawInput: PayrollRunInput): Promise<PayrollRunWithDetails | null> {
    const input = normalizeRunInput(rawInput);
    validateRunInput(input);

    const reference = input.reference?.trim() || buildReference(input.periodStart);
    const policy = input.shopId
      ? await this.payrollPolicyRepository.findDefaultForShop(input.shopId, new Date())
      : null;

    const run = await this.repository.create({
      reference,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payDate: input.payDate ?? null,
      status: input.status ?? 'DRAFT',
      shopId: input.shopId ?? null,
      payrollPolicyId: input.payrollPolicyId ?? policy?.id ?? null,
      currency: input.currency ?? policy?.currency ?? 'USD',
      notes: input.notes ?? null,
    });

    return this.getById(run.id);
  }

  async calculate(
    id: string,
    actorId?: string,
    _actorName?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');
    if (run.status !== 'DRAFT') {
      throw new Error('Only DRAFT runs can be calculated');
    }

    return this.repository.update(id, {
      status: 'CALCULATED',
      calculatedAt: new Date(),
      preparedBy: actorId,
    });
  }

  async submitForReview(
    id: string,
    _actorId?: string,
    _actorName?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');
    if (run.status !== 'CALCULATED') {
      throw new Error('Only CALCULATED runs can be submitted for review');
    }

    return this.repository.update(id, {
      status: 'UNDER_REVIEW',
      reviewedAt: new Date(),
    });
  }

  async approve(
    id: string,
    actorId?: string,
    _actorName?: string,
    _comment?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');
    if (run.status !== 'UNDER_REVIEW') {
      throw new Error('Only UNDER_REVIEW runs can be approved');
    }

    return this.repository.update(id, {
      status: 'APPROVED',
      approvedBy: actorId,
      approvedAt: new Date(),
      lockedAt: new Date(),
    });
  }

  async reject(
    id: string,
    _actorId?: string,
    _actorName?: string,
    _comment?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');
    if (run.status !== 'UNDER_REVIEW') {
      throw new Error('Only UNDER_REVIEW runs can be rejected');
    }

    return this.repository.update(id, { status: 'DRAFT' });
  }

  async markPaid(
    id: string,
    _actorId?: string,
    _actorName?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');
    if (run.status !== 'APPROVED') {
      throw new Error('Only APPROVED runs can be marked as paid');
    }

    return this.repository.update(id, {
      status: 'PAID',
      paidAt: new Date(),
    });
  }

  async voidRun(
    id: string,
    _actorId?: string,
    _actorName?: string,
    _reason?: string,
  ): Promise<PayrollRunRecord> {
    const run = await this.getById(id);
    if (!run) throw new Error('Payroll run not found');

    if (['PAID', 'VOID'].includes(run.status)) {
      throw new Error('A paid or voided payroll run cannot be voided');
    }

    return this.repository.update(id, { status: 'VOID' });
  }
}
