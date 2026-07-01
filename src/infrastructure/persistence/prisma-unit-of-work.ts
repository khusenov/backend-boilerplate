import type { PrismaClient } from '@/generated/prisma/client';
import type {
  UnitOfWork,
  TransactionalRepositories,
} from '@/application/shared/ports/unit-of-work';
import { PrismaUserRepository } from './prisma-user-repository';
import { PrismaRoleRepository } from './prisma-role-repository';
import { PrismaPermissionRepository } from './prisma-permission-repository';
import { PrismaUserRoleRepository } from './prisma-user-role-repository';

interface PrismaUnitOfWorkDeps {
  prisma: PrismaClient;
}

export class PrismaUnitOfWork implements UnitOfWork {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: PrismaUnitOfWorkDeps) {
    this.prisma = prisma;
  }

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const repos: TransactionalRepositories = {
        userRepository: new PrismaUserRepository({ prisma: tx }),
        roleRepository: new PrismaRoleRepository({ prisma: tx }),
        permissionRepository: new PrismaPermissionRepository({ prisma: tx }),
        userRoleRepository: new PrismaUserRoleRepository({ prisma: tx }),
      };
      return work(repos);
    });
  }
}
