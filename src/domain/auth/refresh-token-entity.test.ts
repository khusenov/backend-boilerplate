import { describe, expect, it } from 'vitest';
import { RefreshToken } from './refresh-token-entity';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:00:01.000Z');
const FUTURE = new Date('2026-12-31T00:00:00.000Z');
const PAST = new Date('2025-01-01T00:00:00.000Z');

function makeToken(
  overrides: Partial<Parameters<typeof RefreshToken.create>[0]> = {},
): RefreshToken {
  return RefreshToken.create(
    {
      id: 'token-1',
      userId: 'user-1',
      familyId: 'family-1',
      tokenHash: 'hash-abc',
      expiresAt: FUTURE,
      ...overrides,
    },
    BASE_TIME,
  );
}

describe('RefreshToken', () => {
  describe('create', () => {
    it('creates a fresh token with usedAt and revokedAt as null', () => {
      const token = makeToken();

      expect(token.userId).toBe('user-1');
      expect(token.familyId).toBe('family-1');
      expect(token.tokenHash).toBe('hash-abc');
      expect(token.expiresAt).toEqual(FUTURE);
      expect(token.usedAt).toBeNull();
      expect(token.revokedAt).toBeNull();
      expect(token.createdAt).toEqual(BASE_TIME);
      expect(token.updatedAt).toEqual(BASE_TIME);
      expect(token.isDeleted).toBe(false);
    });
  });

  describe('hydrate', () => {
    it('reconstructs a token from stored props without side effects', () => {
      const usedAt = new Date('2026-01-02T00:00:00.000Z');
      const revokedAt = new Date('2026-01-03T00:00:00.000Z');

      const token = RefreshToken.hydrate({
        id: 'token-2',
        userId: 'user-2',
        familyId: 'family-2',
        tokenHash: 'hash-xyz',
        expiresAt: FUTURE,
        usedAt,
        revokedAt,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        deletedAt: null,
      });

      expect(token.usedAt).toBe(usedAt);
      expect(token.revokedAt).toBe(revokedAt);
      expect(token.isUsed).toBe(true);
      expect(token.isRevoked).toBe(true);
    });
  });

  describe('isUsed', () => {
    it('is false when usedAt is null', () => {
      expect(makeToken().isUsed).toBe(false);
    });

    it('is true after markUsed', () => {
      const token = makeToken();
      token.markUsed(LATER);
      expect(token.isUsed).toBe(true);
    });
  });

  describe('isRevoked', () => {
    it('is false when revokedAt is null', () => {
      expect(makeToken().isRevoked).toBe(false);
    });

    it('is true after revoke', () => {
      const token = makeToken();
      token.revoke(LATER);
      expect(token.isRevoked).toBe(true);
    });
  });

  describe('isExpired', () => {
    it('is false when expiresAt is after the supplied instant', () => {
      expect(makeToken({ expiresAt: FUTURE }).isExpired(BASE_TIME)).toBe(false);
    });

    it('is true when expiresAt is before the supplied instant', () => {
      expect(makeToken({ expiresAt: PAST }).isExpired(BASE_TIME)).toBe(true);
    });

    it('is true when expiresAt equals the supplied instant', () => {
      expect(makeToken({ expiresAt: BASE_TIME }).isExpired(BASE_TIME)).toBe(true);
    });

    it('flips as the supplied instant crosses expiresAt', () => {
      const token = makeToken({ expiresAt: LATER });
      expect(token.isExpired(new Date(LATER.getTime() - 1))).toBe(false);
      expect(token.isExpired(new Date(LATER.getTime() + 1))).toBe(true);
    });
  });

  describe('isActive', () => {
    it('is true when not used, not revoked, and not expired', () => {
      expect(makeToken().isActive(BASE_TIME)).toBe(true);
    });

    it('is false when used', () => {
      const token = makeToken();
      token.markUsed(LATER);
      expect(token.isActive(LATER)).toBe(false);
    });

    it('is false when revoked', () => {
      const token = makeToken();
      token.revoke(LATER);
      expect(token.isActive(LATER)).toBe(false);
    });

    it('is false when expired', () => {
      expect(makeToken({ expiresAt: PAST }).isActive(BASE_TIME)).toBe(false);
    });
  });

  describe('markUsed', () => {
    it('sets usedAt and updatedAt to the supplied instant', () => {
      const token = makeToken();

      token.markUsed(LATER);

      expect(token.usedAt).toEqual(LATER);
      expect(token.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the token is already used', () => {
      const token = makeToken();
      token.markUsed(LATER);
      const usedAt = token.usedAt;

      token.markUsed(new Date('2026-01-01T00:00:02.000Z'));

      expect(token.usedAt).toBe(usedAt);
    });
  });

  describe('revoke', () => {
    it('sets revokedAt and updatedAt to the supplied instant', () => {
      const token = makeToken();

      token.revoke(LATER);

      expect(token.revokedAt).toEqual(LATER);
      expect(token.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the token is already revoked', () => {
      const token = makeToken();
      token.revoke(LATER);
      const revokedAt = token.revokedAt;

      token.revoke(new Date('2026-01-01T00:00:02.000Z'));

      expect(token.revokedAt).toBe(revokedAt);
    });
  });

  describe('equals', () => {
    it('is true for two tokens with the same id', () => {
      const a = makeToken({ id: 'same-id' });
      const b = makeToken({ id: 'same-id', tokenHash: 'different-hash' });

      expect(a.equals(b)).toBe(true);
    });

    it('is false for different ids and for undefined', () => {
      expect(makeToken({ id: 'a' }).equals(makeToken({ id: 'b' }))).toBe(false);
      expect(makeToken().equals(undefined)).toBe(false);
    });
  });
});
