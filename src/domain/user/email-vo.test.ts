import { Email, InvalidEmailError } from './email-vo';
import { describe, expect, it } from 'vitest';

describe('Email', () => {
  describe('create', () => {
    it('create an email from a valid address', () => {
      const email = Email.create('user@example.com');
      expect(email.value).toBe('user@example.com');
    });

    it('trims surrounding whitespace and lowercases the address', () => {
      const email = Email.create('   User@Example.COM   ');
      expect(email.value).toBe('user@example.com');
    });

    it.each([
      '',
      '   ',
      'notanemail',
      'missing@domain',
      '@example.com',
      'user@.com',
      'user@domain.',
      'first last@example.com',
    ])('throws InvalidEmailError for %j', (raw) => {
      expect(() => Email.create(raw)).toThrow(InvalidEmailError);
    });
  });

  describe('equals', () => {
    it('returns true for two email with the same normalized value', () => {
      const a = Email.create('user@example.com');
      const b = Email.create('USER@example.com');
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for emails with different values', () => {
      const a = Email.create('a@example.com');
      const b = Email.create('b@example.com');
      expect(a.equals(b)).toBe(false);
    });

    it('returns false when compared with undefined', () => {
      const email = Email.create('user@example.com');
      expect(email.equals(undefined)).toBe(false);
    });
  });

  describe('toString', () => {
    it('returns the normalized value', () => {
      const email = Email.create('User@Example.com');
      expect(email.toString()).toBe('user@example.com');
    });
  });
});
