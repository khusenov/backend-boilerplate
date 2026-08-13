import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditUser } from './edit-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { EmailAlreadyTakenError, UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import { User, UserStatus } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';

const RAW_CODE = '123456';
const CODE_HASH = 'hmac-of-123456';
const MAX_ATTEMPTS = 5;

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.UsersUpdate.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

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

function makeOtherUser(): User {
  return User.create(
    {
      id: 'user-2',
      firstName: 'John',
      lastName: 'Smith',
      email: Email.create('taken@example.com'),
      passwordHash: 'hashed-pw',
    },
    CREATED_AT,
  );
}

function makeEditUser() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>().mockResolvedValue(undefined),
  } satisfies UserRepository;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const txSave = vi.fn<UserRepository['save']>().mockResolvedValue(undefined);
  const txCreateCode = vi
    .fn<EmailVerificationCodeRepository['create']>()
    .mockResolvedValue(undefined);
  const txUpdateCode = vi
    .fn<EmailVerificationCodeRepository['update']>()
    .mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({
      userRepository: { save: txSave },
      emailVerificationCodeRepository: { create: txCreateCode, update: txUpdateCode },
    } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const findActiveByUserId = vi
    .fn<EmailVerificationCodeRepository['findActiveByUserId']>()
    .mockResolvedValue(null);
  const emailVerificationCodeRepository = {
    findActiveByUserId,
  } as unknown as EmailVerificationCodeRepository;

  const issuedCode = EmailVerificationCode.issue(
    {
      id: 'new-code-id',
      userId: 'user-1',
      codeHash: CODE_HASH,
      expiresAt: NOW,
      maxAttempts: MAX_ATTEMPTS,
    },
    NOW,
  );
  const issue = vi
    .fn<VerificationCodeIssuer['issue']>()
    .mockReturnValue({ code: issuedCode, rawCode: RAW_CODE });
  const reissue = vi.fn<VerificationCodeIssuer['reissue']>().mockReturnValue(RAW_CODE);
  const verificationCodeIssuer = { issue, reissue } as unknown as VerificationCodeIssuer;

  const enqueue = vi.fn<JobQueue['enqueue']>().mockResolvedValue(undefined);
  const jobQueue = { enqueue } as unknown as JobQueue;

  const sut = new EditUser({
    userRepository: users,
    clock,
    unitOfWork,
    emailVerificationCodeRepository,
    verificationCodeIssuer,
    jobQueue,
  });

  return {
    sut,
    users,
    clock,
    run,
    txSave,
    txCreateCode,
    txUpdateCode,
    findActiveByUserId,
    issue,
    reissue,
    issuedCode,
    enqueue,
  };
}

describe('EditUser', () => {
  let ctx: ReturnType<typeof makeEditUser>;

  beforeEach(() => {
    ctx = makeEditUser();
  });

  describe('execute', () => {
    it('throws UserNotFoundError when the user does not exist', async () => {
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ id: 'user-1' }, ACTOR)).rejects.toThrow(UserNotFoundError);
    });

    it('throws InvalidEmailError for a malformed email', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await expect(ctx.sut.execute({ id: 'user-1', email: 'not-an-email' }, ACTOR)).rejects.toThrow(
        InvalidEmailError,
      );
    });

    it('throws EmailAlreadyTakenError when the new email belongs to another user', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(makeOtherUser());

      await expect(
        ctx.sut.execute({ id: 'user-1', email: 'taken@example.com' }, ACTOR),
      ).rejects.toThrow(EmailAlreadyTakenError);
    });

    it('does not call findByEmail when the email is unchanged', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1', email: 'jane@example.com' }, ACTOR);

      expect(ctx.users.findByEmail).not.toHaveBeenCalled();
    });

    it('updates firstName when provided', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ id: 'user-1', firstName: 'Janet' }, ACTOR);

      expect(result.firstName).toBe('Janet');
    });

    it('updates lastName when provided', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ id: 'user-1', lastName: 'Smith' }, ACTOR);

      expect(result.lastName).toBe('Smith');
    });

    it('updates email when it is available', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);
      ctx.users.findByEmail.mockResolvedValue(null);

      const result = await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR);

      expect(result.email).toBe('new@example.com');
    });

    it('persists the updated user in the repository', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ id: 'user-1', firstName: 'Janet' }, ACTOR);

      expect(ctx.txSave).toHaveBeenCalledOnce();
      expect(ctx.txSave).toHaveBeenCalledWith(user);
    });

    it('returns a mapped UserDto on success', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute(
        { id: 'user-1', firstName: 'Janet', lastName: 'Smith' },
        ACTOR,
      );

      expect(result.id).toBe('user-1');
      expect(result.firstName).toBe('Janet');
      expect(result.lastName).toBe('Smith');
      expect(result.fullName).toBe('Janet Smith');
      expect(result.email).toBe('jane@example.com');
    });

    it('stamps two mutations with one shared instant from a single clock reading', async () => {
      const user = makeUser();
      ctx.users.findById.mockResolvedValue(user);
      ctx.users.findByEmail.mockResolvedValue(null);

      await ctx.sut.execute({ id: 'user-1', firstName: 'Janet', email: 'new@example.com' }, ACTOR);

      expect(user.updatedAt).toEqual(NOW);
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });

    it('does not read the clock when the user does not exist', async () => {
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ id: 'user-1' }, ACTOR)).rejects.toThrow(UserNotFoundError);

      expect(ctx.clock.now).not.toHaveBeenCalled();
    });

    it('demotes the user to pending and returns it in the response', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(null);

      const result = await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR);

      expect(result.status).toBe(UserStatus.Pending);
    });

    it('creates a new verification code when none is active', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(null);
      ctx.findActiveByUserId.mockResolvedValue(null);

      await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR);

      expect(ctx.issue).toHaveBeenCalledWith('user-1', NOW);
      expect(ctx.txCreateCode).toHaveBeenCalledWith(ctx.issuedCode);
      expect(ctx.txUpdateCode).not.toHaveBeenCalled();
    });

    it('reissues the existing active code instead of creating a duplicate', async () => {
      const existingCode = EmailVerificationCode.issue(
        {
          id: 'code-1',
          userId: 'user-1',
          codeHash: 'old-hash',
          expiresAt: NOW,
          maxAttempts: MAX_ATTEMPTS,
        },
        CREATED_AT,
      );
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(null);
      ctx.findActiveByUserId.mockResolvedValue(existingCode);

      await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR);

      expect(ctx.reissue).toHaveBeenCalledWith(existingCode, NOW);
      expect(ctx.txUpdateCode).toHaveBeenCalledWith(existingCode);
      expect(ctx.txCreateCode).not.toHaveBeenCalled();
    });

    it('enqueues the verification email after the transaction commits', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(null);

      await ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR);

      expect(ctx.enqueue).toHaveBeenCalledWith(SEND_VERIFICATION_EMAIL_JOB, {
        email: 'new@example.com',
        code: RAW_CODE,
      });
      expect(ctx.txCreateCode.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    it('does not enqueue when the transaction fails', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());
      ctx.users.findByEmail.mockResolvedValue(null);
      ctx.run.mockRejectedValue(new Error('deadlock'));

      await expect(
        ctx.sut.execute({ id: 'user-1', email: 'new@example.com' }, ACTOR),
      ).rejects.toThrow('deadlock');

      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('does not touch verification machinery when only the name changes', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1', firstName: 'Janet' }, ACTOR);

      expect(ctx.findActiveByUserId).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('does not touch verification machinery when the email is unchanged', async () => {
      ctx.users.findById.mockResolvedValue(makeUser());

      await ctx.sut.execute({ id: 'user-1', email: 'jane@example.com' }, ACTOR);

      expect(ctx.findActiveByUserId).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });
  });
});

describe('EditUser authorization', () => {
  it('denies a caller without users.update before touching the repository', async () => {
    const ctx = makeEditUser();

    await expect(
      ctx.sut.execute({ id: 'user-1', firstName: 'Renamed' }, UNPRIVILEGED_ACTOR),
    ).rejects.toThrow(PermissionDeniedError);

    expect(ctx.users.findById).not.toHaveBeenCalled();
  });

  it('lets a user edit their own record while holding no permissions', async () => {
    const ctx = makeEditUser();
    ctx.users.findById.mockResolvedValue(makeUser());

    await ctx.sut.execute(
      { id: UNPRIVILEGED_ACTOR.userId, firstName: 'Renamed' },
      UNPRIVILEGED_ACTOR,
    );

    expect(ctx.users.findById).toHaveBeenCalledWith(UNPRIVILEGED_ACTOR.userId);
    expect(ctx.txSave).toHaveBeenCalledOnce();
  });
});
