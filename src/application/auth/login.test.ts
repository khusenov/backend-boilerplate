import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from './login';
import type { AuthTokensDto } from './auth-dto';
import type { SessionService } from './session-service';
import { InvalidCredentialsError } from '@/domain/auth/auth-errors';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';

const FAKE_TOKENS: AuthTokensDto = {
  accessToken: 'access.token.jwt',
  refreshToken: 'raw-refresh-opaque',
};

function makeActiveUser(): User {
  return User.create({
    id: 'user-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-secret',
  });
}

function makeInactiveUser(): User {
  const user = makeActiveUser();
  user.deactivate();
  return user;
}

function makeLogin() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    create: vi.fn<UserRepository['create']>(),
    update: vi.fn<UserRepository['update']>(),
  } satisfies UserRepository;

  const hasher = {
    hash: vi.fn<PasswordHasher['hash']>(),
    verify: vi.fn<PasswordHasher['verify']>(),
  } satisfies PasswordHasher;

  const sessions = {
    issue: vi.fn().mockResolvedValue(FAKE_TOKENS),
    reissue: vi.fn(),
  } as unknown as SessionService;

  const sut = new Login({
    userRepository: users,
    passwordHasher: hasher,
    sessionService: sessions,
  });

  return { sut, users, hasher, sessions };
}

describe('Login', () => {
  let ctx: ReturnType<typeof makeLogin>;

  beforeEach(() => {
    ctx = makeLogin();
  });

  describe('execute', () => {
    it('throws InvalidEmailError for a malformed email', async () => {
      await expect(ctx.sut.execute({ email: 'not-an-email', password: 'pw' })).rejects.toThrow(
        InvalidEmailError,
      );
    });

    it('throws InvalidCredentialsError when the user does not exist', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      await expect(ctx.sut.execute({ email: 'jane@example.com', password: 'pw' })).rejects.toThrow(
        InvalidCredentialsError,
      );
    });

    it('throws InvalidCredentialsError when the password is wrong', async () => {
      ctx.users.findByEmail.mockResolvedValue(makeActiveUser());
      ctx.hasher.verify.mockResolvedValue(false);

      await expect(
        ctx.sut.execute({ email: 'jane@example.com', password: 'wrong' }),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('throws InvalidCredentialsError when the user is inactive', async () => {
      ctx.users.findByEmail.mockResolvedValue(makeInactiveUser());
      ctx.hasher.verify.mockResolvedValue(true);

      await expect(
        ctx.sut.execute({ email: 'jane@example.com', password: 'correct' }),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('returns a mapped UserDto and tokens on success', async () => {
      const user = makeActiveUser();
      ctx.users.findByEmail.mockResolvedValue(user);
      ctx.hasher.verify.mockResolvedValue(true);

      const result = await ctx.sut.execute({ email: 'jane@example.com', password: 'correct' });

      expect(result.user.id).toBe('user-1');
      expect(result.user.firstName).toBe('Jane');
      expect(result.user.lastName).toBe('Doe');
      expect(result.user.fullName).toBe('Jane Doe');
      expect(result.user.email).toBe('jane@example.com');
      expect(result.user.status).toBe('active');
      expect(result.tokens).toEqual(FAKE_TOKENS);
    });

    it('verifies the supplied password against the stored hash', async () => {
      const user = makeActiveUser();
      ctx.users.findByEmail.mockResolvedValue(user);
      ctx.hasher.verify.mockResolvedValue(true);

      await ctx.sut.execute({ email: 'jane@example.com', password: 'my-password' });

      expect(ctx.hasher.verify).toHaveBeenCalledOnce();
      expect(ctx.hasher.verify).toHaveBeenCalledWith('my-password', user.passwordHash);
    });

    it('looks up the user by the normalised email (lowercased, trimmed)', async () => {
      ctx.users.findByEmail.mockResolvedValue(null);

      await expect(
        ctx.sut.execute({ email: '  JANE@EXAMPLE.COM  ', password: 'pw' }),
      ).rejects.toThrow(InvalidCredentialsError);

      expect(ctx.users.findByEmail).toHaveBeenCalledOnce();
      const [passedEmail] = ctx.users.findByEmail.mock.calls[0]!;
      expect(passedEmail.toString()).toBe('jane@example.com');
    });
  });
});
