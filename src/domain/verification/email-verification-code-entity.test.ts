import { describe, expect, it } from 'vitest';
import { EmailVerificationCode } from './email-verification-code-entity';
import {
  TooManyVerificationAttemptsError,
  VerificationCodeExpiredError,
  VerificationCodeInvalidError,
} from './verification-errors';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:15:00.000Z');
const WITHIN_TTL = new Date('2026-01-01T00:10:00.000Z');
const AFTER_TTL = new Date('2026-01-01T00:20:00.000Z');
const MAX_ATTEMPTS = 5;
const CODE_HASH = 'hmac-of-123456';
const WRONG_HASH = 'hmac-of-000000';

function issue(): EmailVerificationCode {
  return EmailVerificationCode.issue(
    {
      id: 'code-1',
      userId: 'user-1',
      codeHash: CODE_HASH,
      expiresAt: EXPIRES_AT,
      maxAttempts: MAX_ATTEMPTS,
    },
    ISSUED_AT,
  );
}

function hydrate(
  overrides: Partial<Parameters<typeof EmailVerificationCode.hydrate>[0]> = {},
): EmailVerificationCode {
  return EmailVerificationCode.hydrate({
    id: 'code-1',
    userId: 'user-1',
    codeHash: CODE_HASH,
    expiresAt: EXPIRES_AT,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    deletedAt: null,
    ...overrides,
  });
}

describe('EmailVerificationCode', () => {
  describe('issue', () => {
    it('starts unconsumed with a zeroed attempt counter', () => {
      const code = issue();

      expect(code.attempts).toBe(0);
      expect(code.maxAttempts).toBe(MAX_ATTEMPTS);
      expect(code.consumedAt).toBeNull();
      expect(code.isConsumed).toBe(false);
    });

    it('stamps createdAt and updatedAt from a single instant', () => {
      const code = issue();

      expect(code.createdAt).toEqual(ISSUED_AT);
      expect(code.updatedAt).toEqual(ISSUED_AT);
      expect(code.deletedAt).toBeNull();
    });

    it('carries the issued identity, owner, and hash', () => {
      const code = issue();

      expect(code.id).toBe('code-1');
      expect(code.userId).toBe('user-1');
      expect(code.codeHash).toBe(CODE_HASH);
      expect(code.expiresAt).toEqual(EXPIRES_AT);
    });
  });

  describe('verify', () => {
    it('consumes the code when the hash matches within the TTL', () => {
      const code = issue();

      code.verify(CODE_HASH, WITHIN_TTL);

      expect(code.isConsumed).toBe(true);
      expect(code.consumedAt).toEqual(WITHIN_TTL);
      expect(code.updatedAt).toEqual(WITHIN_TTL);
      expect(code.attempts).toBe(0);
    });

    it('increments attempts and rejects a mismatched hash', () => {
      const code = issue();

      expect(() => code.verify(WRONG_HASH, WITHIN_TTL)).toThrow(VerificationCodeInvalidError);

      expect(code.attempts).toBe(1);
      expect(code.updatedAt).toEqual(WITHIN_TTL);
      expect(code.isConsumed).toBe(false);
    });

    it('rejects an already-consumed code', () => {
      const code = hydrate({ consumedAt: WITHIN_TTL });

      expect(() => code.verify(CODE_HASH, WITHIN_TTL)).toThrow(VerificationCodeInvalidError);
    });

    it('rejects a second use of a code consumed in this process', () => {
      const code = issue();
      code.verify(CODE_HASH, WITHIN_TTL);

      expect(() => code.verify(CODE_HASH, WITHIN_TTL)).toThrow(VerificationCodeInvalidError);
    });

    it('rejects an expired code', () => {
      const code = issue();

      expect(() => code.verify(CODE_HASH, AFTER_TTL)).toThrow(VerificationCodeExpiredError);
    });

    it('treats the expiry instant itself as expired', () => {
      const code = issue();

      expect(() => code.verify(CODE_HASH, EXPIRES_AT)).toThrow(VerificationCodeExpiredError);
    });

    it('rejects a code whose attempts already reached the cap', () => {
      const code = hydrate({ attempts: MAX_ATTEMPTS });

      expect(() => code.verify(CODE_HASH, WITHIN_TTL)).toThrow(TooManyVerificationAttemptsError);
    });

    it('refuses even the correct hash once the cap is reached', () => {
      const code = hydrate({ attempts: MAX_ATTEMPTS });

      expect(() => code.verify(CODE_HASH, WITHIN_TTL)).toThrow(TooManyVerificationAttemptsError);
      expect(code.isConsumed).toBe(false);
    });

    it('allows the final attempt below the cap', () => {
      const code = hydrate({ attempts: MAX_ATTEMPTS - 1 });

      code.verify(CODE_HASH, WITHIN_TTL);

      expect(code.isConsumed).toBe(true);
    });

    it('reaches the cap after exactly maxAttempts wrong guesses', () => {
      const code = issue();

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        expect(() => code.verify(WRONG_HASH, WITHIN_TTL)).toThrow(VerificationCodeInvalidError);
      }

      expect(code.attempts).toBe(MAX_ATTEMPTS);
      expect(() => code.verify(WRONG_HASH, WITHIN_TTL)).toThrow(TooManyVerificationAttemptsError);
    });
  });

  // The verify use case persists the entity only when `attempts` moved, so the
  // guard order below is load-bearing, not cosmetic.
  describe('guard order (consumed -> expired -> cap -> mismatch)', () => {
    it('reports consumption before expiry', () => {
      const code = hydrate({ consumedAt: WITHIN_TTL, attempts: MAX_ATTEMPTS });

      expect(() => code.verify(WRONG_HASH, AFTER_TTL)).toThrow(VerificationCodeInvalidError);
    });

    it('reports expiry before the attempt cap', () => {
      const code = hydrate({ attempts: MAX_ATTEMPTS });

      expect(() => code.verify(WRONG_HASH, AFTER_TTL)).toThrow(VerificationCodeExpiredError);
    });

    it('reports the attempt cap before a hash mismatch', () => {
      const code = hydrate({ attempts: MAX_ATTEMPTS });

      expect(() => code.verify(WRONG_HASH, WITHIN_TTL)).toThrow(TooManyVerificationAttemptsError);
    });

    it.each([
      ['consumed', hydrate({ consumedAt: WITHIN_TTL }), WITHIN_TTL],
      ['expired', hydrate(), AFTER_TTL],
      ['capped', hydrate({ attempts: MAX_ATTEMPTS }), WITHIN_TTL],
    ])('leaves the entity untouched when %s', (_label, code, now) => {
      const attemptsBefore = code.attempts;
      const updatedAtBefore = code.updatedAt;

      expect(() => code.verify(WRONG_HASH, now)).toThrow();

      expect(code.attempts).toBe(attemptsBefore);
      expect(code.updatedAt).toBe(updatedAtBefore);
    });
  });
});
