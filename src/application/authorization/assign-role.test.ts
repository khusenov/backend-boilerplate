import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssignRole } from './assign-role';
import { Role } from '@/domain/authorization/role-entity';
import { User } from '@/domain/user/user-entity';
import { Email } from '@/domain/user/email-vo';
import type { UserRepository } from '@/domain/user/user-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';
import { RoleNotFoundError, SystemRoleProtectedError } from '@/domain/authorization/role-errors';

function makeUser(): User {
  return User.create({
    id: 'user-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hash',
  });
}

function makeAssignRole() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>(),
    save: vi.fn<RoleRepository['save']>(),
  } satisfies RoleRepository;

  const userRoles = {
    listRoleIdsForUser: vi.fn<UserRoleRepository['listRoleIdsForUser']>(),
    assign: vi.fn<UserRoleRepository['assign']>().mockResolvedValue(undefined),
    revoke: vi.fn<UserRoleRepository['revoke']>(),
  } satisfies UserRoleRepository;

  const sut = new AssignRole({
    userRepository: users,
    roleRepository: roles,
    userRoleRepository: userRoles,
  });

  return { sut, users, roles, userRoles };
}

describe('AssignRole', () => {
  let ctx: ReturnType<typeof makeAssignRole>;

  beforeEach(() => {
    ctx = makeAssignRole();
  });

  it('throws UserNotFoundError when the user does not exist', async () => {
    ctx.users.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' })).rejects.toThrow(
      UserNotFoundError,
    );
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.users.findById.mockResolvedValue(makeUser());
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' })).rejects.toThrow(
      RoleNotFoundError,
    );
  });

  it('refuses to assign a system role through the API', async () => {
    ctx.users.findById.mockResolvedValue(makeUser());
    ctx.roles.findById.mockResolvedValue(
      Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' }),
    );

    await expect(ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' })).rejects.toThrow(
      SystemRoleProtectedError,
    );
    expect(ctx.userRoles.assign).not.toHaveBeenCalled();
  });

  it('assigns the role with a grant timestamp', async () => {
    ctx.users.findById.mockResolvedValue(makeUser());
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }));

    await ctx.sut.execute({ userId: 'user-1', roleId: 'role-1' });

    expect(ctx.userRoles.assign).toHaveBeenCalledOnce();
    const [userId, roleId, grantedAt] = ctx.userRoles.assign.mock.calls[0]!;
    expect(userId).toBe('user-1');
    expect(roleId).toBe('role-1');
    expect(grantedAt).toBeInstanceOf(Date);
  });
});
