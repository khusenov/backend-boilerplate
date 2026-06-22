import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshToken } from './refresh-token-entity';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-31T00:00:00.000Z');
const PAST = new Date('2025-01-01T00:00:00.000Z');

function makeToken(
  overrides: Partial<Parameters<typeof RefreshToken.create>[0]> = {},
): RefreshToken {
  return RefreshToken.create({
    id: 'token-1',
    userId: 'user-1',
    familyId: 'family-1',
    tokenHash: 'hash-abc',
    expiresAt: FUTURE,
    ...overrides,
  });
}

describe('RefreshToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      token.markUsed();
      expect(token.isUsed).toBe(true);
    });
  });

  describe('isRevoked', () => {
    it('is false when revokedAt is null', () => {
      expect(makeToken().isRevoked).toBe(false);
    });

    it('is true after revoke', () => {
      const token = makeToken();
      token.revoke();
      expect(token.isRevoked).toBe(true);
    });
  });

  describe('isExpired', () => {
    it('is false when expiresAt is in the future', () => {
      expect(makeToken({ expiresAt: FUTURE }).isExpired()).toBe(false);
    });

    it('is true when expiresAt is in the past', () => {
      expect(makeToken({ expiresAt: PAST }).isExpired()).toBe(true);
    });

    it('is true when expiresAt equals now', () => {
      expect(makeToken({ expiresAt: BASE_TIME }).isExpired()).toBe(true);
    });

    it('accepts an explicit now reference', () => {
      const token = makeToken({ expiresAt: FUTURE });
      expect(token.isExpired(new Date('2027-01-01T00:00:00.000Z'))).toBe(true);
    });
  });

  describe('isActive', () => {
    it('is true when not used, not revoked, and not expired', () => {
      expect(makeToken().isActive()).toBe(true);
    });

    it('is false when used', () => {
      const token = makeToken();
      token.markUsed();
      expect(token.isActive()).toBe(false);
    });

    it('is false when revoked', () => {
      const token = makeToken();
      token.revoke();
      expect(token.isActive()).toBe(false);
    });

    it('is false when expired', () => {
      expect(makeToken({ expiresAt: PAST }).isActive()).toBe(false);
    });
  });

  describe('markUsed', () => {
    it('sets usedAt and bumps updatedAt', () => {
      const token = makeToken();
      vi.advanceTimersByTime(1000);

      token.markUsed();

      expect(token.usedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
      expect(token.updatedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    });

    it('is a no-op when the token is already used', () => {
      const token = makeToken();
      token.markUsed();
      const usedAt = token.usedAt;
      vi.advanceTimersByTime(1000);

      token.markUsed();

      expect(token.usedAt).toBe(usedAt);
    });
  });

  describe('revoke', () => {
    it('sets revokedAt and bumps updatedAt', () => {
      const token = makeToken();
      vi.advanceTimersByTime(1000);

      token.revoke();

      expect(token.revokedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
      expect(token.updatedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    });

    it('is a no-op when the token is already revoked', () => {
      const token = makeToken();
      token.revoke();
      const revokedAt = token.revokedAt;
      vi.advanceTimersByTime(1000);

      token.revoke();

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
