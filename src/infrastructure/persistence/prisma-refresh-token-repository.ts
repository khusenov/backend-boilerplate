import { toDomain, toPersistence } from './prisma-refresh-token-mapper';
import { mapPrismaError } from './prisma-error';
import type { PrismaClient } from '@/generated/prisma/client';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { RefreshToken } from '@/domain/auth/refresh-token-entity';

interface Deps {
  prisma: PrismaClient;
}

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: Deps) {
    this.prisma = prisma;
  }

  async create(token: RefreshToken): Promise<void> {
    try {
      await this.prisma.refreshToken.create({ data: toPersistence(token) });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row ? toDomain(row) : null;
  }

  async update(token: RefreshToken): Promise<void> {
    try {
      await this.prisma.refreshToken.update({
        where: { id: token.id },
        data: toPersistence(token),
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt, updatedAt: revokedAt },
    });
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt, updatedAt: revokedAt },
    });
  }

  async deleteExpired(now: Date): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}
