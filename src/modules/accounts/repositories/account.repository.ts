import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma.js';
import type { IAccountRepository } from '../interfaces/account.repository.interface.js';
import type { AccountWithParent } from '../interfaces/account.types.js';

const parentSelect = { id: true, code: true, name: true } as const;

export class AccountRepository implements IAccountRepository {
  list(): Promise<AccountWithParent[]> {
    return prisma.account.findMany({
      include: { parent: { select: parentSelect } },
      orderBy: { code: 'asc' },
    });
  }

  findByCode(code: string) {
    return prisma.account.findUnique({ where: { code } });
  }

  findWithParentByCode(code: string): Promise<AccountWithParent | null> {
    return prisma.account.findUnique({
      where: { code },
      include: { parent: { select: parentSelect } },
    });
  }

  create(data: Prisma.AccountUncheckedCreateInput): Promise<AccountWithParent> {
    return prisma.account.create({
      data,
      include: { parent: { select: parentSelect } },
    });
  }

  updateByCode(code: string, data: Prisma.AccountUncheckedUpdateInput): Promise<AccountWithParent> {
    return prisma.account.update({
      where: { code },
      data,
      include: { parent: { select: parentSelect } },
    });
  }
}
