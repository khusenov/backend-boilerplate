import { describe, expect, it } from 'vitest';
import { toDomain, toPersistence } from './prisma-refresh-token-mapper';
import type { RefreshToken as PrismaRefreshToken } from '@/generated/prisma/client';

function makeTokenRow(overrides: Partial<PrismaRefreshToken> = {}): PrismaRefreshToken {
  const now = new Date('2024-01-15T10:00:00.000Z');
  return {
    id: 'token-1',
    userId: 'user-1',
    familyId: 'family-1',
    tokenHash: 'abc123hash',
    expiresAt: new Date('2024-01-29T10:00:00.000Z'),
    usedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('prisma-refresh-token-mapper', () => {
  describe('toDomain', () => {
    it('maps all scalar fields from the row', () => {
      const row = makeTokenRow();
      const token = toDomain(row);

      expect(token.id).toBe('token-1');
      expect(token.userId).toBe('user-1');
      expect(token.familyId).toBe('family-1');
      expect(token.tokenHash).toBe('abc123hash');
      expect(token.expiresAt).toEqual(row.expiresAt);
      expect(token.createdAt).toEqual(row.createdAt);
      expect(token.updatedAt).toEqual(row.updatedAt);
    });

    it('maps null usedAt and revokedAt', () => {
      const token = toDomain(makeTokenRow({ usedAt: null, revokedAt: null }));
      expect(token.usedAt).toBeNull();
      expect(token.revokedAt).toBeNull();
    });

    it('maps non-null usedAt', () => {
      const usedAt = new Date('2024-01-20T08:00:00.000Z');
      const token = toDomain(makeTokenRow({ usedAt }));
      expect(token.usedAt).toEqual(usedAt);
    });

    it('maps non-null revokedAt', () => {
      const revokedAt = new Date('2024-01-21T09:00:00.000Z');
      const token = toDomain(makeTokenRow({ revokedAt }));
      expect(token.revokedAt).toEqual(revokedAt);
    });

    it('always sets deletedAt to null', () => {
      const token = toDomain(makeTokenRow());
      expect(token.deletedAt).toBeNull();
    });
  });

  describe('toPersistence', () => {
    it('round-trips losslessly through toDomain', () => {
      const row = makeTokenRow();
      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('round-trips with usedAt set', () => {
      const usedAt = new Date('2024-01-20T08:00:00.000Z');
      const row = makeTokenRow({ usedAt });
      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('round-trips with revokedAt set', () => {
      const revokedAt = new Date('2024-01-21T09:00:00.000Z');
      const row = makeTokenRow({ revokedAt });
      expect(toPersistence(toDomain(row))).toEqual(row);
    });
  });
});
