import { PrismaUserRepository } from './prisma-user-repository';
import { PrismaRoleRepository } from './prisma-role-repository';
import { PrismaPermissionRepository } from './prisma-permission-repository';
import { PrismaUserRoleRepository } from './prisma-user-role-repository';
import { PrismaEmailVerificationCodeRepository } from './prisma-email-verification-code-repository';
import { PrismaPasswordResetTokenRepository } from './prisma-password-reset-token-repository';
import type { PrismaClient } from '@/generated/prisma/client';
import type {
  TransactionContext,
  TransactionalRepositories,
  UnitOfWork,
} from '@/application/shared/ports/unit-of-work';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { PrismaOutboxWriter } from './prisma-outbox-writer';

export interface PrismaUnitOfWorkDeps {
  prisma: PrismaClient;
  outboxWriter: PrismaOutboxWriter;
}

export class PrismaUnitOfWork implements UnitOfWork {
  private readonly prisma: PrismaClient;
  private readonly outboxWriter: PrismaOutboxWriter;

  constructor({ prisma, outboxWriter }: PrismaUnitOfWorkDeps) {
    this.prisma = prisma;
    this.outboxWriter = outboxWriter;
  }

  async run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const staged: DomainEvent[] = [];
      const repos: TransactionalRepositories = {
        userRepository: new PrismaUserRepository({ prisma: tx }),
        roleRepository: new PrismaRoleRepository({ prisma: tx }),
        permissionRepository: new PrismaPermissionRepository({ prisma: tx }),
        userRoleRepository: new PrismaUserRoleRepository({ prisma: tx }),
        emailVerificationCodeRepository: new PrismaEmailVerificationCodeRepository({ prisma: tx }),
        passwordResetTokenRepository: new PrismaPasswordResetTokenRepository({ prisma: tx }),
      };
      const context: TransactionContext = {
        ...repos,
        outbox: { stage: (events) => staged.push(...events) },
      };
      const result = await work(context);
      await this.outboxWriter.write(staged, tx);
      return result;
    });
  }
}
