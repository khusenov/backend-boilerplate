import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  const sut = new Argon2PasswordHasher();

  describe('hash', () => {
    it('returns a non-empty string', async () => {
      await expect(sut.hash('password')).resolves.toBeTruthy();
    });

    it('does not return the original plain text', async () => {
      const result = await sut.hash('password');
      expect(result).not.toBe('password');
    });

    it('returns different hashes on successive calls (salted)', async () => {
      const [a, b] = await Promise.all([sut.hash('password'), sut.hash('password')]);
      expect(a).not.toBe(b);
    });
  });

  describe('verify', () => {
    it('returns true for the correct password', async () => {
      const hashed = await sut.hash('correct-password');
      await expect(sut.verify('correct-password', hashed)).resolves.toBe(true);
    });

    it('returns false for a wrong password', async () => {
      const hashed = await sut.hash('correct-password');
      await expect(sut.verify('wrong-password', hashed)).resolves.toBe(false);
    });

    it('returns false for a malformed hash without throwing', async () => {
      await expect(sut.verify('any-password', 'not-a-valid-hash')).resolves.toBe(false);
    });
  });
});
