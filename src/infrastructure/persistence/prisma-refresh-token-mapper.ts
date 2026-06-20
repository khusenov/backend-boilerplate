import type { RefreshToken as PrismaRefreshToken } from '@/generated/prisma/client';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';

export function toDomain(row: PrismaRefreshToken): RefreshToken {
  return RefreshToken.hydrate({
    id: row.id,
    userId: row.userId,
    familyId: row.familyId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: null,
  });
}

export function toPersistence(token: RefreshToken): PrismaRefreshToken {
  return {
    id: token.id,
    userId: token.userId,
    familyId: token.familyId,
    tokenHash: token.tokenHash,
    expiresAt: token.expiresAt,
    usedAt: token.usedAt,
    revokedAt: token.revokedAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}
