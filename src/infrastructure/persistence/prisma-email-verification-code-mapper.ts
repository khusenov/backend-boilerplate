import type { EmailVerificationCode as PrismaEmailVerificationCode } from '@/generated/prisma/client';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';

export function toDomain(row: PrismaEmailVerificationCode): EmailVerificationCode {
  return EmailVerificationCode.hydrate({
    id: row.id,
    userId: row.userId,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: null,
  });
}

export function toPersistence(code: EmailVerificationCode): PrismaEmailVerificationCode {
  return {
    id: code.id,
    userId: code.userId,
    codeHash: code.codeHash,
    expiresAt: code.expiresAt,
    attempts: code.attempts,
    maxAttempts: code.maxAttempts,
    consumedAt: code.consumedAt,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
  };
}
