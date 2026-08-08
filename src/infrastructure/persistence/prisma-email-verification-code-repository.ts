import { toDomain, toPersistence } from './prisma-email-verification-code-mapper';
import { mapPrismaError } from './prisma-error';
import type { PrismaTransactionalClient } from './prisma-transactional-client';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';

interface Deps {
  prisma: PrismaTransactionalClient;
}

export class PrismaEmailVerificationCodeRepository implements EmailVerificationCodeRepository {
  private readonly prisma: PrismaTransactionalClient;

  constructor({ prisma }: Deps) {
    this.prisma = prisma;
  }

  async create(code: EmailVerificationCode): Promise<void> {
    try {
      await this.prisma.emailVerificationCode.create({ data: toPersistence(code) });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async update(code: EmailVerificationCode): Promise<void> {
    try {
      await this.prisma.emailVerificationCode.update({
        where: { id: code.id },
        data: toPersistence(code),
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async findActiveByUserId(userId: string): Promise<EmailVerificationCode | null> {
    const row = await this.prisma.emailVerificationCode.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }
}
