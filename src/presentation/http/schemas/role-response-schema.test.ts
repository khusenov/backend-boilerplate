import { describe, expect, it } from 'vitest';

import { paginatedRoles, roleResponse } from './role-response-schema';

describe('roleResponse schema', () => {
  const validRole = {
    id: '22222222-2222-4222-8222-222222222222',
    key: null,
    name: 'Support',
    description: null,
    isSystem: false,
    permissions: ['users.read', 'users.update'],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  };

  it('accepts a valid RoleDto with null key and description', () => {
    expect(() => roleResponse.parse(validRole)).not.toThrow();
  });

  it('accepts a system role with a non-null key', () => {
    const system = { ...validRole, key: 'super-admin', isSystem: true };
    expect(() => roleResponse.parse(system)).not.toThrow();
  });

  it('strips internal fields that are not part of the contract', () => {
    const leaky = { ...validRole, internalFlag: 'secret' };
    const parsed = roleResponse.parse(leaky);
    expect(parsed).not.toHaveProperty('internalFlag');
  });

  it('rejects a non-array permissions value', () => {
    const invalid = { ...validRole, permissions: 'users.read' };
    expect(() => roleResponse.parse(invalid)).toThrow();
  });

  it('wraps items in the standard pagination envelope and strips per-item extras', () => {
    const page = {
      items: [{ ...validRole, secret: 'x' }],
      page: 1,
      pageSize: 10,
      total: 1,
      hasNext: false,
      hasPrev: false,
    };
    const parsed = paginatedRoles.parse(page);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).not.toHaveProperty('secret');
  });
});
