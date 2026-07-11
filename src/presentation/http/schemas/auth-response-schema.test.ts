import { describe, expect, it } from 'vitest';

import { loginResponse, refreshResponse } from './auth-response-schema';

describe('auth response schemas', () => {
  const validUser = {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: 'Ada Lovelace',
    email: 'ada@finflow.test',
    status: 'active' as const,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  };

  describe('loginResponse', () => {
    it('accepts a valid { user, accessToken }', () => {
      expect(() => loginResponse.parse({ user: validUser, accessToken: 'jwt' })).not.toThrow();
    });

    it('strips passwordHash from the nested user (defense in depth)', () => {
      const leaky = {
        user: { ...validUser, passwordHash: 'super-secret-hash' },
        accessToken: 'jwt',
      };
      const parsed = loginResponse.parse(leaky);
      expect(parsed.user).not.toHaveProperty('passwordHash');
    });

    it('rejects a missing accessToken', () => {
      expect(() => loginResponse.parse({ user: validUser })).toThrow();
    });
  });

  describe('refreshResponse', () => {
    it('accepts a bare access token', () => {
      expect(() => refreshResponse.parse({ accessToken: 'jwt' })).not.toThrow();
    });

    it('strips any extra fields (e.g. a leaked refresh token)', () => {
      const parsed = refreshResponse.parse({
        accessToken: 'jwt',
        refreshToken: 'should-not-be-here',
      });
      expect(parsed).not.toHaveProperty('refreshToken');
    });
  });
});
