import { describe, expect, it } from 'vitest';
import { ANONYMOUS_ACTOR, createUserActor } from './actor';
import { PERMISSIONS, SUPERADMIN_ROLE_KEY } from './permission-catalogue';

describe('createUserActor', () => {
  it('maps every field through unchanged', () => {
    const actor = createUserActor({
      userId: 'user-1',
      systemRoleKeys: [SUPERADMIN_ROLE_KEY],
      permissions: [PERMISSIONS.UsersRead.key],
    });

    expect(actor.kind).toBe('user');
    expect(actor.userId).toBe('user-1');
    expect(actor.systemRoleKeys).toEqual([SUPERADMIN_ROLE_KEY]);
    expect(actor.permissions).toEqual([PERMISSIONS.UsersRead.key]);
  });

  it('freezes the actor and both of its grant arrays', () => {
    const actor = createUserActor({ userId: 'user-1', systemRoleKeys: [], permissions: [] });

    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(actor.systemRoleKeys)).toBe(true);
    expect(Object.isFrozen(actor.permissions)).toBe(true);
  });

  it('is unaffected by mutating the source arrays after construction', () => {
    const permissions: string[] = [PERMISSIONS.UsersRead.key];
    const systemRoleKeys: string[] = [];

    const actor = createUserActor({ userId: 'user-1', systemRoleKeys, permissions });
    permissions.push(PERMISSIONS.UsersDelete.key);
    systemRoleKeys.push(SUPERADMIN_ROLE_KEY);

    expect(actor.permissions).toEqual([PERMISSIONS.UsersRead.key]);
    expect(actor.systemRoleKeys).toEqual([]);
  });
});

describe('ANONYMOUS_ACTOR', () => {
  it('is a frozen actor of kind anonymous', () => {
    expect(ANONYMOUS_ACTOR.kind).toBe('anonymous');
    expect(Object.isFrozen(ANONYMOUS_ACTOR)).toBe(true);
  });
});
