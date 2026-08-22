import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteUser } from './delete-user';
import { UserNotFoundError } from '@/domain/user/user-errors';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeUser } from '@test/unit/support/builders';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.UsersDelete.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeDeleteUser() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>().mockResolvedValue(undefined),
  } satisfies UserRepository;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new DeleteUser({ userRepository: users, clock });

  return { sut, users, clock };
}

describe('DeleteUser', () => {
  let ctx: ReturnType<typeof makeDeleteUser>;

  beforeEach(() => {
    ctx = makeDeleteUser();
  });

  describe('execute', () => {
    it('throws UserNotFoundError when the user does not exist', async () => {
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ id: 'user-1' }, ACTOR)).rejects.toThrow(UserNotFoundError);
    });

    it('soft-deletes the user entity', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' }, ACTOR);

      expect(user.isDeleted).toBe(true);
    });

    it('persists the deleted user in the repository', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' }, ACTOR);

      expect(ctx.users.save).toHaveBeenCalledOnce();
      expect(ctx.users.save).toHaveBeenCalledWith(user);
    });

    it('stamps deletedAt and updatedAt from a single clock reading', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' }, ACTOR);

      expect(user.deletedAt).toEqual(NOW);
      expect(user.updatedAt).toEqual(NOW);
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });
  });
});

describe('DeleteUser authorization', () => {
  it('denies a caller without users.delete before touching the repository', async () => {
    const ctx = makeDeleteUser();

    await expect(ctx.sut.execute({ id: 'user-1' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.users.findById).not.toHaveBeenCalled();
  });
});
