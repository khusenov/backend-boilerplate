import { describe, expect, it } from 'vitest';
import {
  MIN_SECRET_LENGTH,
  assertProductionSecrets,
  type SecretPolicyInput,
} from './assert-production-secrets';

const strongSecret = 'a'.repeat(MIN_SECRET_LENGTH + 8);

function makeEnv(overrides: Partial<SecretPolicyInput> = {}) {
  return {
    isProduction: true,
    COOKIE_SECRET: strongSecret,
    JWT_ACCESS_SECRET: strongSecret,
    BULL_BOARD_ENABLED: false,
    BULL_BOARD_PASSWORD: '',
    VERIFICATION_CODE_SECRET: strongSecret,
    ...overrides,
  };
}

describe('assertProductionSecrets', () => {
  describe('outside production', () => {
    it('does not throw even when both secrets are empty', () => {
      const env = makeEnv({ isProduction: false, COOKIE_SECRET: '', JWT_ACCESS_SECRET: '' });
      expect(() => assertProductionSecrets(env)).not.toThrow();
    });
  });

  describe('in production', () => {
    it('does not throw when both secrets exceed the minimum length', () => {
      expect(() => assertProductionSecrets(makeEnv())).not.toThrow();
    });

    it('accepts a secret exactly at the minimum length', () => {
      const env = makeEnv({ COOKIE_SECRET: 'a'.repeat(MIN_SECRET_LENGTH) });
      expect(() => assertProductionSecrets(env)).not.toThrow();
    });

    it('throws when a secret is one character below the minimum', () => {
      const env = makeEnv({ COOKIE_SECRET: 'a'.repeat(MIN_SECRET_LENGTH - 1) });
      expect(() => assertProductionSecrets(env)).toThrow(/COOKIE_SECRET/);
    });

    it('throws when COOKIE_SECRET is missing (empty)', () => {
      const env = makeEnv({ COOKIE_SECRET: '' });
      expect(() => assertProductionSecrets(env)).toThrow(/COOKIE_SECRET/);
    });

    it('throws when JWT_ACCESS_SECRET is too short', () => {
      const env = makeEnv({ JWT_ACCESS_SECRET: 'short' });
      expect(() => assertProductionSecrets(env)).toThrow(/JWT_ACCESS_SECRET/);
    });

    it('names every weak secret in a single error', () => {
      const env = makeEnv({ COOKIE_SECRET: '', JWT_ACCESS_SECRET: 'short' });
      expect(() => assertProductionSecrets(env)).toThrow(/COOKIE_SECRET, JWT_ACCESS_SECRET/);
    });

    it('includes a remediation hint in the error message', () => {
      const env = makeEnv({ COOKIE_SECRET: '' });
      expect(() => assertProductionSecrets(env)).toThrow(/openssl rand/);
    });
  });
});
