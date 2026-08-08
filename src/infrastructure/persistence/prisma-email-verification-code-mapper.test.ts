import { describe, expect, it } from 'vitest';
import { toDomain, toPersistence } from './prisma-email-verification-code-mapper';
import type { EmailVerificationCode as PrismaEmailVerificationCode } from '@/generated/prisma/client';

function makeCodeRow(
  overrides: Partial<PrismaEmailVerificationCode> = {},
): PrismaEmailVerificationCode {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'code-1',
    userId: 'user-1',
    codeHash: 'a'.repeat(64),
    expiresAt: new Date('2026-01-01T00:15:00.000Z'),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('prisma-email-verification-code-mapper', () => {
  describe('toDomain', () => {
    it('maps all scalar fields from the row', () => {
      const row = makeCodeRow();
      const code = toDomain(row);

      expect(code.id).toBe('code-1');
      expect(code.userId).toBe('user-1');
      expect(code.codeHash).toBe(row.codeHash);
      expect(code.expiresAt).toEqual(row.expiresAt);
      expect(code.attempts).toBe(0);
      expect(code.maxAttempts).toBe(5);
      expect(code.createdAt).toEqual(row.createdAt);
      expect(code.updatedAt).toEqual(row.updatedAt);
    });

    it('maps a null consumedAt to an unconsumed code', () => {
      const code = toDomain(makeCodeRow({ consumedAt: null }));

      expect(code.consumedAt).toBeNull();
      expect(code.isConsumed).toBe(false);
    });

    it('maps a non-null consumedAt to a consumed code', () => {
      const consumedAt = new Date('2026-01-01T00:05:00.000Z');
      const code = toDomain(makeCodeRow({ consumedAt }));

      expect(code.consumedAt).toEqual(consumedAt);
      expect(code.isConsumed).toBe(true);
    });

    it('carries a partially spent attempt counter', () => {
      const code = toDomain(makeCodeRow({ attempts: 3 }));

      expect(code.attempts).toBe(3);
    });

    // The table has no deleted_at column, so the entity's soft-delete surface is
    // synthesized rather than read.
    it('always sets deletedAt to null', () => {
      const code = toDomain(makeCodeRow());

      expect(code.deletedAt).toBeNull();
      expect(code.isDeleted).toBe(false);
    });
  });

  describe('toPersistence', () => {
    it('round-trips losslessly through toDomain', () => {
      const row = makeCodeRow();

      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('round-trips a consumed code', () => {
      const row = makeCodeRow({ consumedAt: new Date('2026-01-01T00:05:00.000Z') });

      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('round-trips a spent attempt counter', () => {
      const row = makeCodeRow({ attempts: 4, maxAttempts: 4 });

      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('emits no deletedAt key, matching the table columns', () => {
      expect(toPersistence(toDomain(makeCodeRow()))).not.toHaveProperty('deletedAt');
    });
  });
});
