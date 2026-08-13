import { toDomain, toPersistence } from './prisma-password-reset-token-mapper';
import { mapPrismaError } from './prisma-error';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

interface PrismaPasswordResetTokenRepositoryDeps {
  prisma: PrismaTransactionalClient;
}

export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  private readonly prisma: PrismaTransactionalClient;

  constructor({ prisma }: PrismaPasswordResetTokenRepositoryDeps) {
    this.prisma = prisma;
  }

  async create(token: PasswordResetToken): Promise<void> {
    try {
      await this.prisma.passwordResetToken.create({ data: toPersistence(token) });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async update(token: PasswordResetToken): Promise<void> {
    try {
      await this.prisma.passwordResetToken.update({
        where: { id: token.id },
        data: toPersistence(token),
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const row = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    return row ? toDomain(row) : null;
  }

  async invalidateAllForUser(userId: string, now: Date): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now, updatedAt: now },
    });
  }

  async deleteExpired(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return count;
  }
}
