import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RevokeRole } from './revoke-role';
import type { UserRepository } from '@/domain/user/user-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeUser } from '@test/unit/support/builders';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesAssign.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

function makeRevokeRole() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const userRoles = {
    listRoleIdsForUser: vi.fn<UserRoleRepository['listRoleIdsForUser']>(),
    assign: vi.fn<UserRoleRepository['assign']>(),
    revoke: vi.fn<UserRoleRepository['revoke']>().mockResolvedValue(undefined),
  } satisfies UserRoleRepository;

  const sut = new RevokeRole({ userRepository: users, userRoleRepository: userRoles });

  return { sut, users, userRoles };
}

describe('RevokeRole', () => {
  let ctx: ReturnType<typeof makeRevokeRole>;

  beforeEach(() => {
    ctx = makeRevokeRole();
  });

  it('throws UserNotFoundError when the user does not exist', async () => {
    ctx.users.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' }, ACTOR)).rejects.toThrow(
      UserNotFoundError,
    );
    expect(ctx.userRoles.revoke).not.toHaveBeenCalled();
  });

  it('revokes the user-role link', async () => {
    ctx.users.findById.mockResolvedValue(makeUser());

    await ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' }, ACTOR);

    expect(ctx.userRoles.revoke).toHaveBeenCalledWith('user-1', 'role-1');
  });
});

describe('RevokeRole authorization', () => {
  it('denies a caller without roles.assign before touching any repository', async () => {
    const ctx = makeRevokeRole();

    await expect(
      ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' }, UNPRIVILEGED_ACTOR),
    ).rejects.toThrow(PermissionDeniedError);

    expect(ctx.users.findById).not.toHaveBeenCalled();
    expect(ctx.userRoles.revoke).not.toHaveBeenCalled();
  });
});
