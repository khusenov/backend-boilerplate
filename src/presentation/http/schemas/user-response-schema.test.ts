import { describe, expect, it } from 'vitest';

import { paginatedUsers, userResponse } from './user-response-schema';

describe('userResponse schema', () => {
  const validUser = {
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: 'Ada Lovelace',
    email: 'ada@example.test',
    status: 'active' as const,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  };

  it('accepts a valid UserDto', () => {
    expect(() => userResponse.parse(validUser)).not.toThrow();
  });

  it('strips internal fields that are not part of the contract', () => {
    const leaky = { ...validUser, passwordHash: 'super-secret-hash' };
    const parsed = userResponse.parse(leaky);
    expect(parsed).not.toHaveProperty('passwordHash');
  });

  it('rejects an unknown status value', () => {
    const invalid = { ...validUser, status: 'deleted' };
    expect(() => userResponse.parse(invalid)).toThrow();
  });

  it('wraps items in the standard pagination envelope and strips secrets per item', () => {
    const page = {
      items: [{ ...validUser, passwordHash: 'leak' }],
      page: 1,
      pageSize: 10,
      total: 1,
      hasNext: false,
      hasPrev: false,
    };
    const parsed = paginatedUsers.parse(page);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).not.toHaveProperty('passwordHash');
  });
});
