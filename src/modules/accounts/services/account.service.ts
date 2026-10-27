import { Prisma } from '@prisma/client';
import type { IAccountRepository } from '../interfaces/account.repository.interface.js';
import type { IAccountService } from '../interfaces/account.service.interface.js';
import { AccountApplicationError } from '../errors/account.error.js';
import type { AccountInput, AccountWithParent } from '../interfaces/account.types.js';

function normalizeInput(input: AccountInput): AccountInput {
  return {
    ...input,
    code: input.code.trim(),
    name: input.name.trim(),
    parentCode: input.parentCode?.trim() || null,
    description: input.description?.trim() || null,
  };
}

function validateInput(input: AccountInput): void {
  if (!input.code) throw new AccountApplicationError('Account code is required', 400);
  if (!input.name) throw new AccountApplicationError('Account name is required', 400);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class AccountService implements IAccountService {
  constructor(private readonly accountRepository: IAccountRepository) {}

  list() {
    return this.accountRepository.list();
  }

  getByCode(code: string) {
    return this.accountRepository.findWithParentByCode(code);
  }

  async create(rawInput: AccountInput): Promise<AccountWithParent> {
    const input = normalizeInput(rawInput);
    validateInput(input);
    const parent = await this.resolveParent(input.parentCode);

    try {
      return await this.accountRepository.create({
        code: input.code,
        name: input.name,
        type: input.type,
        status: input.status ?? 'ACTIVE',
        description: input.description,
        parentId: parent?.id ?? null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AccountApplicationError('Account code already exists', 409);
      }
      throw error;
    }
  }

  async update(currentCode: string, rawInput: AccountInput): Promise<AccountWithParent | null> {
    const input = normalizeInput(rawInput);
    validateInput(input);
    const existing = await this.accountRepository.findByCode(currentCode);
    if (!existing) return null;
    const parent = await this.resolveParent(input.parentCode, currentCode);

    try {
      return await this.accountRepository.updateByCode(currentCode, {
        code: input.code,
        name: input.name,
        type: input.type,
        status: input.status ?? existing.status,
        description: input.description,
        parentId: parent?.id ?? null,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AccountApplicationError('Account code already exists', 409);
      }
      throw error;
    }
  }

  async toggleStatus(code: string): Promise<AccountWithParent | null> {
    const existing = await this.accountRepository.findByCode(code);
    if (!existing) return null;
    return this.accountRepository.updateByCode(code, {
      status: existing.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
    });
  }

  private async resolveParent(parentCode?: string | null, currentCode?: string) {
    if (!parentCode) return null;
    if (parentCode === currentCode) {
      throw new AccountApplicationError('An account cannot be its own parent', 400);
    }

    const parent = await this.accountRepository.findByCode(parentCode);
    if (!parent) {
      throw new AccountApplicationError(`Parent account ${parentCode} was not found`, 400);
    }
    return parent;
  }
}
