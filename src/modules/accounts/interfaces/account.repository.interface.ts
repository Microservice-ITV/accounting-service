import type { Account, Prisma } from '@prisma/client';
import type { AccountWithParent } from './account.types.js';

export interface IAccountRepository {
  list(): Promise<AccountWithParent[]>;
  findByCode(code: string): Promise<Account | null>;
  findWithParentByCode(code: string): Promise<AccountWithParent | null>;
  create(data: Prisma.AccountUncheckedCreateInput): Promise<AccountWithParent>;
  updateByCode(code: string, data: Prisma.AccountUncheckedUpdateInput): Promise<AccountWithParent>;
}
