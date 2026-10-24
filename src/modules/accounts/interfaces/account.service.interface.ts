import type { AccountInput, AccountWithParent } from './account.types.js';

export interface IAccountService {
  list(): Promise<AccountWithParent[]>;
  getByCode(code: string): Promise<AccountWithParent | null>;
  create(input: AccountInput): Promise<AccountWithParent>;
  update(currentCode: string, input: AccountInput): Promise<AccountWithParent | null>;
  toggleStatus(code: string): Promise<AccountWithParent | null>;
}
