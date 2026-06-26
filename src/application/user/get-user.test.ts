import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetUser } from './get-user';
import { UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';

function makeUser(): User {
  return User.create({
    id: 'user-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-pw',
  });
}

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

      await expect(ctx.sut.execute({ id: 'user-1' })).rejects.toThrow(UserNotFoundError);
    });

    it('looks up the user by id', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1' });

      expect(ctx.users.findById).toHaveBeenCalledOnce();
      expect(ctx.users.findById).toHaveBeenCalledWith('user-1');
    });

    it('returns a mapped UserDto on success', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      const result = await ctx.sut.execute({ id: 'user-1' });

      expect(result.id).toBe('user-1');
      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Doe');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe('active');
    });
  });
});
