import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, type Account } from '@prisma/client';
import { AccountApplicationError } from './errors/account.error.js';
import type { IAccountRepository } from './interfaces/account.repository.interface.js';
import type { AccountInput } from './interfaces/account.types.js';
import { AccountService } from './services/account.service.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'account-1',
  code: '1000',
  name: 'Cash',
  type: 'ASSET',
  status: 'ACTIVE',
  statusDomain: 'ACCOUNT',
  description: null,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

function repository(overrides: Partial<IAccountRepository> = {}): IAccountRepository {
  return {
    list: async () => [],
    findByCode: async () => null,
    findWithParentByCode: async () => null,
    create: async () => ({ ...account(), parent: null }),
    updateByCode: async () => ({ ...account(), parent: null }),
    ...overrides,
  };
}

const validInput: AccountInput = {
  code: ' 1100 ',
  name: ' Bank ',
  type: 'ASSET',
};

test('AccountService normalizes create values and applies active default', async () => {
  let createdData: Parameters<IAccountRepository['create']>[0] | undefined;
  const service = new AccountService(repository({
    create: async (data) => {
      createdData = data;
      return { ...account({ code: '1100', name: 'Bank' }), parent: null };
    },
  }));

  await service.create(validInput);

  assert.equal(createdData?.code, '1100');
  assert.equal(createdData?.name, 'Bank');
  assert.equal(createdData?.status, 'ACTIVE');
  assert.equal(createdData?.description, null);
});

test('AccountService resolves a parent and rejects a missing parent', async () => {
  const parent = account({ id: 'parent-1', code: '1000' });
  let createdData: Parameters<IAccountRepository['create']>[0] | undefined;
  const service = new AccountService(repository({
    findByCode: async (code) => code === '1000' ? parent : null,
    create: async (data) => {
      createdData = data;
      return { ...account(), parent: null };
    },
  }));

  await service.create({ ...validInput, parentCode: '1000' });
  assert.equal(createdData?.parentId, 'parent-1');

  await assert.rejects(
    service.create({ ...validInput, parentCode: '9999' }),
    (error: unknown) => error instanceof AccountApplicationError && error.statusCode === 400,
  );
});

test('AccountService rejects self-parenting', async () => {
  const service = new AccountService(repository({
    findByCode: async (code) => account({ code }),
  }));

  await assert.rejects(
    service.update('1100', { ...validInput, code: '1100', parentCode: '1100' }),
    (error: unknown) => error instanceof AccountApplicationError && /own parent/.test(error.message),
  );
});

test('AccountService preserves status on update when omitted and toggles status', async () => {
  let updatedStatus: string | undefined;
  const service = new AccountService(repository({
    findByCode: async () => account({ status: 'INACTIVE' }),
    findWithParentByCode: async () => ({ ...account(), parent: null }),
    updateByCode: async (_code, data) => {
      updatedStatus = typeof data.status === 'string' ? data.status : data.status?.set;
      return { ...account({ status: updatedStatus ?? 'ACTIVE' }), parent: null };
    },
  }));

  await service.update('1000', validInput);
  assert.equal(updatedStatus, 'INACTIVE');

  await service.toggleStatus('1000');
  assert.equal(updatedStatus, 'ACTIVE');
});

test('AccountService returns null for update when the account does not exist', async () => {
  const service = new AccountService(repository());
  assert.equal(await service.update('missing', validInput), null);
});

test('AccountService maps account-code uniqueness conflicts to HTTP conflict errors', async () => {
  const service = new AccountService(repository({
    create: async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['code'] },
      });
    },
  }));

  await assert.rejects(
    service.create(validInput),
    (error: unknown) => error instanceof AccountApplicationError && error.statusCode === 409,
  );
});
