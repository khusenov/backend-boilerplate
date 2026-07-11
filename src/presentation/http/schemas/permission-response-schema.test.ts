import { describe, expect, it } from 'vitest';

import { permissionsResponse } from './permission-response-schema';

describe('permissionsResponse schema', () => {
  const validCatalogue = [
    {
      category: 'users',
      permissions: [
        { key: 'users.read', name: 'View users' },
        { key: 'users.create', name: 'Create users' },
      ],
    },
    {
      category: 'roles',
      permissions: [{ key: 'roles.read', name: 'View roles' }],
    },
  ];

  it('accepts a valid grouped catalogue', () => {
    expect(() => permissionsResponse.parse(validCatalogue)).not.toThrow();
  });

  it('strips unknown fields from groups and items', () => {
    const leaky = [
      {
        category: 'users',
        extra: 'nope',
        permissions: [{ key: 'users.read', name: 'View users', secret: 'x' }],
      },
    ];
    const parsed = permissionsResponse.parse(leaky);
    expect(parsed[0]).not.toHaveProperty('extra');
    expect(parsed[0]?.permissions[0]).not.toHaveProperty('secret');
  });

  it('rejects an item missing its key', () => {
    const invalid = [{ category: 'users', permissions: [{ name: 'View users' }] }];
    expect(() => permissionsResponse.parse(invalid)).toThrow();
  });
});
