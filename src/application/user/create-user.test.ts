import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateUser } from './create-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';

function makeExistingUser(): User {
  return User.create({
    id: 'user-existing',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-pw',
  });
}

function makeCreateUser() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>().mockResolvedValue(undefined),
  } satisfies UserRepository;

  const hasher = {
    hash: vi.fn<PasswordHasher['hash']>().mockResolvedValue('hashed-secret'),
    verify: vi.fn<PasswordHasher['verify']>(),
  } satisfies PasswordHasher;

  const ids = {
    generate: vi.fn<IdGenerator['generate']>().mockReturnValue('new-user-id'),
  } satisfies IdGenerator;

  const sut = new CreateUser({ userRepository: users, passwordHasher: hasher, idGenerator: ids });

  return { sut, users, hasher, ids };
}

describe('CreateUser', () => {
  let ctx: ReturnType<typeof makeCreateUser>;

  beforeEach(() => {
    ctx = makeCreateUser();
  });

  describe('execute', () => {
    it('throws InvalidEmailError for a malformed email', async () => {
      await expect(
        ctx.sut.execute({
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'not-an-email',
          password: 'pw',
        }),
      ).rejects.toThrow(InvalidEmailError);
    });

    it('throws EmailAlreadyTakenError when the email is already registered', async () => {
      ctx.users.findByEmail.mockResolvedValue(makeExistingUser());

      await expect(
        ctx.sut.execute({
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@example.com',
          password: 'pw',
        }),
      ).rejects.toThrow(EmailAlreadyTakenError);
    });

    it('hashes the password before persisting', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      await ctx.sut.execute({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        password: 'my-password',
      });

      expect(ctx.hasher.hash).toHaveBeenCalledOnce();
      expect(ctx.hasher.hash).toHaveBeenCalledWith('my-password');
    });

    it('generates an id for the new user', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      await ctx.sut.execute({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        password: 'pw',
      });

      expect(ctx.ids.generate).toHaveBeenCalledOnce();
    });

    it('persists the new user in the repository', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      await ctx.sut.execute({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        password: 'pw',
      });

      expect(ctx.users.save).toHaveBeenCalledOnce();
      const [createdUser] = ctx.users.save.mock.calls[0]!;
      expect(createdUser.id).toBe('new-user-id');
    });

    it('returns a mapped UserDto on success', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      const result = await ctx.sut.execute({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        password: 'pw',
      });

      expect(result.id).toBe('new-user-id');
      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Doe');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe('active');
    });
  });
});
