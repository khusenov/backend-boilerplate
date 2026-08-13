import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import type { PasswordResetToken as PrismaPasswordResetToken } from '@/generated/prisma/client';

export function toDomain(row: PrismaPasswordResetToken): PasswordResetToken {
  return PasswordResetToken.hydrate({
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: null,
  });
}

export function toPersistence(token: PasswordResetToken): PrismaPasswordResetToken {
  return {
    id: token.id,
    userId: token.userId,
    tokenHash: token.tokenHash,
    expiresAt: token.expiresAt,
    usedAt: token.usedAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}
