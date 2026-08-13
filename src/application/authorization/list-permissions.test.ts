import { describe, expect, it } from 'vitest';
import { ListPermissions } from './list-permissions';
import { ALL_PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesRead.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

describe('ListPermissions', () => {
  it('returns the catalogue grouped by category', () => {
    const result = new ListPermissions().execute(ACTOR);

    const categories = result.map((g) => g.category);
    expect(categories).toEqual(['users', 'roles']);

    const flatKeys = result.flatMap((g) => g.permissions.map((p) => p.key));
    expect(flatKeys.sort()).toEqual(ALL_PERMISSIONS.map((p) => p.key).sort());
  });

  it('groups every permission under exactly one category', () => {
    const result = new ListPermissions().execute(ACTOR);

    const total = result.reduce((sum, g) => sum + g.permissions.length, 0);
    expect(total).toBe(ALL_PERMISSIONS.length);
  });
});

describe('ListPermissions authorization', () => {
  it('denies a caller without roles.read', () => {
    expect(() => new ListPermissions().execute(UNPRIVILEGED_ACTOR)).toThrow(PermissionDeniedError);
  });
});
