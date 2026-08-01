import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteUser } from './delete-user';
import { UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeUser(): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: Email.create('jane@example.com'),
      passwordHash: 'hashed-pw',
    },
    CREATED_AT,
  );
}

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

      await expect(ctx.sut.execute({ id: 'user-1' })).rejects.toThrow(UserNotFoundError);
    });

    it('soft-deletes the user entity', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' });

      expect(user.isDeleted).toBe(true);
    });

    it('persists the deleted user in the repository', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' });

      expect(ctx.users.save).toHaveBeenCalledOnce();
      expect(ctx.users.save).toHaveBeenCalledWith(user);
    });

    it('stamps deletedAt and updatedAt from a single clock reading', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1' });

      expect(user.deletedAt).toEqual(NOW);
      expect(user.updatedAt).toEqual(NOW);
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });
  });
});
