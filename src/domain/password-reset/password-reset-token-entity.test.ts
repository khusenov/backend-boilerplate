import { describe, expect, it } from 'vitest';
import { PasswordResetToken } from './password-reset-token-entity';
import {
  PasswordResetTokenExpiredError,
  PasswordResetTokenInvalidError,
} from './password-reset-errors';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:30:00.000Z');
const WITHIN_TTL = new Date('2026-01-01T00:15:00.000Z');
const AFTER_TTL = new Date('2026-01-01T00:45:00.000Z');
const TOKEN_HASH = 'hmac-of-raw-token';

function issue(): PasswordResetToken {
  return PasswordResetToken.issue(
    {
      id: 'reset-token-1',
      userId: 'user-1',
      tokenHash: TOKEN_HASH,
      expiresAt: EXPIRES_AT,
    },
    ISSUED_AT,
  );
}

function hydrate(
  overrides: Partial<Parameters<typeof PasswordResetToken.hydrate>[0]> = {},
): PasswordResetToken {
  return PasswordResetToken.hydrate({
    id: 'reset-token-1',
    userId: 'user-1',
    tokenHash: TOKEN_HASH,
    expiresAt: EXPIRES_AT,
    usedAt: null,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    deletedAt: null,
    ...overrides,
  });
}

describe('PasswordResetToken', () => {
  describe('issue', () => {
    it('starts unused', () => {
      const token = issue();

      expect(token.usedAt).toBeNull();
      expect(token.isUsed).toBe(false);
    });

    it('stamps createdAt and updatedAt from a single instant', () => {
      const token = issue();

      expect(token.createdAt).toEqual(ISSUED_AT);
      expect(token.updatedAt).toEqual(ISSUED_AT);
      expect(token.deletedAt).toBeNull();
    });

    it('carries the issued identity, owner, and hash', () => {
      const token = issue();

      expect(token.id).toBe('reset-token-1');
      expect(token.userId).toBe('user-1');
      expect(token.tokenHash).toBe(TOKEN_HASH);
      expect(token.expiresAt).toEqual(EXPIRES_AT);
    });
  });

  describe('consume', () => {
    it('marks the token used within the TTL', () => {
      const token = issue();

      token.consume(WITHIN_TTL);

      expect(token.isUsed).toBe(true);
      expect(token.usedAt).toEqual(WITHIN_TTL);
      expect(token.updatedAt).toEqual(WITHIN_TTL);
    });

    it('rejects an already-used token', () => {
      const token = hydrate({ usedAt: WITHIN_TTL });

      expect(() => token.consume(WITHIN_TTL)).toThrow(PasswordResetTokenInvalidError);
    });

    it('rejects a second consume of a token used in this process', () => {
      const token = issue();
      token.consume(WITHIN_TTL);

      expect(() => token.consume(WITHIN_TTL)).toThrow(PasswordResetTokenInvalidError);
    });

    it('rejects an expired token', () => {
      const token = issue();

      expect(() => token.consume(AFTER_TTL)).toThrow(PasswordResetTokenExpiredError);
    });

    it('treats the expiry instant itself as expired', () => {
      const token = issue();

      expect(() => token.consume(EXPIRES_AT)).toThrow(PasswordResetTokenExpiredError);
    });

    it('reports use before expiry', () => {
      const token = hydrate({ usedAt: WITHIN_TTL });

      expect(() => token.consume(AFTER_TTL)).toThrow(PasswordResetTokenInvalidError);
    });

    it.each([
      ['used', hydrate({ usedAt: WITHIN_TTL }), WITHIN_TTL],
      ['expired', hydrate(), AFTER_TTL],
    ])('leaves the entity untouched when %s', (_label, token, now) => {
      const usedAtBefore = token.usedAt;
      const updatedAtBefore = token.updatedAt;

      expect(() => token.consume(now)).toThrow();

      expect(token.usedAt).toBe(usedAtBefore);
      expect(token.updatedAt).toBe(updatedAtBefore);
    });
  });
});
