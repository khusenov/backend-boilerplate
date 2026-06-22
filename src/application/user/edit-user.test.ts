import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditUser } from './edit-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { EmailAlreadyTakenError, UserNotFoundError } from '@/domain/user/user-errors';
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

function makeOtherUser(): User {
  return User.create({
    id: 'user-2',
    firstName: 'John',
    lastName: 'Smith',
    email: Email.create('taken@example.com'),
    passwordHash: 'hashed-pw',
  });
}

function makeEditUser() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    create: vi.fn<UserRepository['create']>(),
    update: vi.fn<UserRepository['update']>().mockResolvedValue(undefined),
  } satisfies UserRepository;

  const sut = new EditUser({ userRepository: users });

  return { sut, users };
}

describe('EditUser', () => {
  let ctx: ReturnType<typeof makeEditUser>;

  beforeEach(() => {
    ctx = makeEditUser();
  });

  describe('execute', () => {
    it('throws UserNotFoundError when the user does not exist', async () => {
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ id: 'user-1' })).rejects.toThrow(UserNotFoundError);
    });

    it('throws InvalidEmailError for a malformed email', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await expect(ctx.sut.execute({ id: 'user-1', email: 'not-an-email' })).rejects.toThrow(
        InvalidEmailError,
      );
    });

    it('throws EmailAlreadyTakenError when the new email belongs to another user', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(makeOtherUser());

      await expect(ctx.sut.execute({ id: 'user-1', email: 'taken@example.com' })).rejects.toThrow(
        EmailAlreadyTakenError,
      );
    });

    it('does not call findByEmail when the email is unchanged', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1', email: 'jane@example.com' });

      expect(ctx.users.findByEmail).not.toHaveBeenCalled();
    });

    it('updates firstName when provided', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ id: 'user-1', firstName: 'Janet' });

      expect(result.firstName).toBe('Janet');
    });

    it('updates lastName when provided', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ id: 'user-1', lastName: 'Smith' });

      expect(result.lastName).toBe('Smith');
    });

    it('updates email when it is available', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);
      ctx.users.findByEmail.mockResolvedValue(null);

      const result = await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' });

      expect(result.email).toBe('new@example.com');
    });

    it('persists the updated user in the repository', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1', firstName: 'Janet' });

      expect(ctx.users.update).toHaveBeenCalledOnce();
      expect(ctx.users.update).toHaveBeenCalledWith(user);
    });

    it('returns a mapped UserDto on success', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ id: 'user-1', firstName: 'Janet', lastName: 'Smith' });

      expect(result.id).toBe('user-1');
      expect(result.firstName).toBe('Janet');
      expect(result.lastName).toBe('Smith');
      expect(result.fullName).toBe('Janet Smith');
      expect(result.email).toBe('jane@example.com');
    });
  });
});
