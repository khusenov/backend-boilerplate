import { describe, expect, it, vi } from 'vitest';
import { VerificationCodeIssuer } from './verification-code-issuer';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { IdGenerator } from '@/application/shared/ports/id-generator';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 900;
const MAX_ATTEMPTS = 5;
const RAW_CODE = '123456';
const CODE_HASH = 'hmac-of-123456';

function makeIssuer() {
  const generate = vi.fn<VerificationCodeService['generate']>().mockReturnValue(RAW_CODE);
  const hash = vi.fn<VerificationCodeService['hash']>().mockReturnValue(CODE_HASH);
  const generateId = vi.fn<IdGenerator['generate']>().mockReturnValue('code-1');

  const issuer = new VerificationCodeIssuer({
    verificationCodeService: { generate, hash },
    idGenerator: { generate: generateId },
    verificationConfig: { ttlSeconds: TTL_SECONDS, maxAttempts: MAX_ATTEMPTS },
  });

  return { issuer, generate, hash, generateId };
}

function makeExistingCode(): EmailVerificationCode {
  return EmailVerificationCode.issue(
    {
      id: 'code-1',
      userId: 'user-1',
      codeHash: 'old-hash',
      expiresAt: NOW,
      maxAttempts: MAX_ATTEMPTS,
    },
    NOW,
  );
}

describe('VerificationCodeIssuer', () => {
  describe('issue', () => {
    it('builds a code hashed from a freshly generated raw code', () => {
      const { issuer } = makeIssuer();

      const { code, rawCode } = issuer.issue('user-1', NOW);

      expect(rawCode).toBe(RAW_CODE);
      expect(code.id).toBe('code-1');
      expect(code.userId).toBe('user-1');
      expect(code.codeHash).toBe(CODE_HASH);
      expect(code.maxAttempts).toBe(MAX_ATTEMPTS);
    });

    it('derives expiry from the configured TTL', () => {
      const { issuer } = makeIssuer();

      const { code } = issuer.issue('user-1', NOW);

      expect(code.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1000));
    });
  });

  describe('reissue', () => {
    it('rotates the hash and expiry on the existing code', () => {
      const { issuer } = makeIssuer();
      const existing = makeExistingCode();

      issuer.reissue(existing, NOW);

      expect(existing.codeHash).toBe(CODE_HASH);
      expect(existing.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1000));
    });

    it('returns the new raw code', () => {
      const { issuer } = makeIssuer();

      const rawCode = issuer.reissue(makeExistingCode(), NOW);

      expect(rawCode).toBe(RAW_CODE);
    });
  });
});
