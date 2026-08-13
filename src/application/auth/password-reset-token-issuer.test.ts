import { describe, expect, it, vi } from 'vitest';
import { PasswordResetTokenIssuer } from './password-reset-token-issuer';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { IdGenerator } from '@/application/shared/ports/id-generator';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 1800;
const RAW_TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'digest-9f8e7d6c5b4a';

function makeIssuer() {
  const generate = vi.fn<OpaqueTokenService['generate']>().mockReturnValue(RAW_TOKEN);
  const hash = vi.fn<OpaqueTokenService['hash']>().mockReturnValue(TOKEN_HASH);
  const generateId = vi.fn<IdGenerator['generate']>().mockReturnValue('reset-token-1');

  const issuer = new PasswordResetTokenIssuer({
    opaqueTokenService: { generate, hash },
    idGenerator: { generate: generateId },
    passwordResetConfig: { ttlSeconds: TTL_SECONDS },
  });

  return { issuer, generate, hash, generateId };
}

describe('PasswordResetTokenIssuer', () => {
  describe('issue', () => {
    it('builds a token hashed from a freshly generated raw token', () => {
      const { issuer } = makeIssuer();

      const { token, rawToken } = issuer.issue('user-1', NOW);

      expect(rawToken).toBe(RAW_TOKEN);
      expect(token.id).toBe('reset-token-1');
      expect(token.userId).toBe('user-1');
      expect(token.tokenHash).toBe(TOKEN_HASH);
    });

    it('derives expiry from the configured TTL', () => {
      const { issuer } = makeIssuer();

      const { token } = issuer.issue('user-1', NOW);

      expect(token.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1000));
    });

    it('never stores the raw token on the entity itself', () => {
      const { issuer } = makeIssuer();

      const { token, rawToken } = issuer.issue('user-1', NOW);

      expect(JSON.stringify(token)).not.toContain(rawToken);
    });
  });
});
