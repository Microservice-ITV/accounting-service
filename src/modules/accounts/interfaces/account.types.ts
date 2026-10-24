import type { Account, AccountType } from '@prisma/client';

export type AccountStatus = 'ACTIVE' | 'INACTIVE';
export type AccountTypeValue = AccountType;

export type AccountInput = {
  code: string;
  name: string;
  type: AccountTypeValue;
  parentCode?: string | null;
  description?: string | null;
  status?: AccountStatus;
};

export type AccountWithParent = Account & {
  parent: Pick<Account, 'id' | 'code' | 'name'> | null;
};
