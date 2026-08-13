import { describe, expect, it } from 'vitest';
import { toRequestActor } from './actor-from-token-payload';
import { ANONYMOUS_ACTOR } from '@/domain/authorization/actor';
import { PERMISSIONS, SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';

describe('toRequestActor', () => {
  it('returns the anonymous actor when there is no verified payload', () => {
    expect(toRequestActor(undefined)).toBe(ANONYMOUS_ACTOR);
  });

  it('maps sub to userId and passes the grants through', () => {
    const actor = toRequestActor({
      sub: 'user-1',
      systemRoleKeys: [SUPERADMIN_ROLE_KEY],
      permissions: [PERMISSIONS.UsersRead.key],
    });

    expect(actor).toEqual({
      kind: 'user',
      userId: 'user-1',
      systemRoleKeys: [SUPERADMIN_ROLE_KEY],
      permissions: [PERMISSIONS.UsersRead.key],
    });
  });

  it('is unaffected by mutating the payload arrays after mapping', () => {
    const payload = {
      sub: 'user-1',
      systemRoleKeys: [] as string[],
      permissions: [PERMISSIONS.UsersRead.key] as string[],
    };

    const actor = toRequestActor(payload);
    payload.permissions.push(PERMISSIONS.UsersDelete.key);
    payload.systemRoleKeys.push(SUPERADMIN_ROLE_KEY);

    expect(actor.kind === 'user' && actor.permissions).toEqual([PERMISSIONS.UsersRead.key]);
    expect(actor.kind === 'user' && actor.systemRoleKeys).toEqual([]);
  });
});
