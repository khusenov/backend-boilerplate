import { describe, expect, it } from 'vitest';
import { CryptoOpaqueTokenService } from './crypto-opaque-token-service';

describe('CryptoOpaqueTokenService', () => {
  const sut = new CryptoOpaqueTokenService();

  describe('generate', () => {
    it('returns a non-empty string', () => {
      expect(sut.generate()).toBeTruthy();
    });

    it('returns a 43-char base64url string (256-bit entropy)', () => {
      expect(sut.generate()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('returns unique values on successive calls', () => {
      const tokens = new Set(Array.from({ length: 20 }, () => sut.generate()));
      expect(tokens.size).toBe(20);
    });
  });

  describe('hash', () => {
    it('returns a 64-char lowercase hex string', () => {
      expect(sut.hash('any-raw-token')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
      expect(sut.hash('my-token')).toBe(sut.hash('my-token'));
    });

    it('returns different hashes for different inputs', () => {
      expect(sut.hash('token-a')).not.toBe(sut.hash('token-b'));
    });
  });
});
