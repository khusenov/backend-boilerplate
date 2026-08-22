import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetUser } from './get-user';
import { UserNotFoundError } from '@/domain/user/user-errors';
import type { UserRepository } from '@/domain/user/user-repository';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeUser } from '@test/unit/support/builders';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.UsersRead.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

function makeGetUser() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const sut = new GetUser({ userRepository: users });

  return { sut, users };
}

describe('GetUser', () => {
  let ctx: ReturnType<typeof makeGetUser>;

  beforeEach(() => {
    ctx = makeGetUser();
  });

  describe('execute', () => {
    it('throws UserNotFoundError when the user does not exist', async () => {
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ id: 'user-1' }, ACTOR)).rejects.toThrow(UserNotFoundError);
    });

    it('looks up the user by id', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1' }, ACTOR);

      expect(ctx.users.findById).toHaveBeenCalledOnce();
      expect(ctx.users.findById).toHaveBeenCalledWith('user-1');
    });

    it('returns a mapped UserDto on success', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      const result = await ctx.sut.execute({ id: 'user-1' }, ACTOR);

      expect(result.id).toBe('user-1');
      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Doe');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe('active');
    });
  });
});

describe('GetUser authorization', () => {
  it('denies a caller without users.read before touching the repository', async () => {
    const ctx = makeGetUser();

    await expect(ctx.sut.execute({ id: 'user-1' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.users.findById).not.toHaveBeenCalled();
  });

  it('lets a user read their own record while holding no permissions', async () => {
    const ctx = makeGetUser();
    ctx.users.findById.mockResolvedValue(makeUser());

    await ctx.sut.execute({ id: UNPRIVILEGED_ACTOR.userId }, UNPRIVILEGED_ACTOR);

    expect(ctx.users.findById).toHaveBeenCalledWith(UNPRIVILEGED_ACTOR.userId);
  });
});
