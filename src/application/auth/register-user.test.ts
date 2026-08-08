import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterUser } from './register-user';
import { Email, InvalidEmailError } from '@/domain/user/email-vo';
import { User, UserStatus } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { Clock } from '@/application/shared/ports/clock';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 900;
const MAX_ATTEMPTS = 5;
const RAW_CODE = '123456';
const CODE_HASH = 'hmac-of-123456';

function makeExistingUser(): User {
  return User.create(
    {
      id: 'user-existing',
      firstName: 'Jane',
      lastName: 'Doe',
      email: Email.create('jane@example.com'),
      passwordHash: 'hashed-pw',
    },
    NOW,
  );
}

function makeDeps() {
  const stage = vi.fn<(events: readonly DomainEvent[]) => void>();
  const txSave = vi.fn<UserRepository['save']>().mockResolvedValue(undefined);
  const txCreateCode = vi
    .fn<EmailVerificationCodeRepository['create']>()
    .mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({
      userRepository: { save: txSave },
      emailVerificationCodeRepository: { create: txCreateCode },
      outbox: { stage },
    } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const findByEmail = vi.fn<UserRepository['findByEmail']>().mockResolvedValue(null);
  const hash = vi.fn<PasswordHasher['hash']>().mockResolvedValue('hashed-secret');
  // Called twice per registration: once for the user, once for the code.
  const generateId = vi
    .fn<IdGenerator['generate']>()
    .mockReturnValueOnce('new-user-id')
    .mockReturnValueOnce('new-code-id');
  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;
  const enqueue = vi.fn<JobQueue['enqueue']>().mockResolvedValue(undefined);
  const codeService = {
    generate: vi.fn<VerificationCodeService['generate']>().mockReturnValue(RAW_CODE),
    hash: vi.fn<VerificationCodeService['hash']>().mockReturnValue(CODE_HASH),
  } satisfies VerificationCodeService;

  const deps = {
    unitOfWork,
    userRepository: { findByEmail } as unknown as UserRepository,
    passwordHasher: { hash } as unknown as PasswordHasher,
    verificationCodeService: codeService,
    jobQueue: { enqueue } as unknown as JobQueue,
    idGenerator: { generate: generateId } as unknown as IdGenerator,
    clock,
    verificationConfig: { ttlSeconds: TTL_SECONDS, maxAttempts: MAX_ATTEMPTS },
  };

  return {
    deps,
    run,
    findByEmail,
    hash,
    generateId,
    enqueue,
    codeService,
    clock,
    stage,
    txSave,
    txCreateCode,
  };
}

const input = {
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  password: 'Str0ng!Pass',
};

describe('RegisterUser', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  describe('execute', () => {
    it('throws InvalidEmailError for a malformed email before touching any collaborator', async () => {
      await expect(
        new RegisterUser(ctx.deps).execute({ ...input, email: 'not-an-email' }),
      ).rejects.toThrow(InvalidEmailError);

      expect(ctx.findByEmail).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email before hashing the password', async () => {
      ctx.findByEmail.mockResolvedValue(makeExistingUser());

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.hash).not.toHaveBeenCalled();
      expect(ctx.run).not.toHaveBeenCalled();
    });

    it('never enqueues an email for a duplicate registration', async () => {
      ctx.findByEmail.mockResolvedValue(makeExistingUser());

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.enqueue).not.toHaveBeenCalled();
      expect(ctx.codeService.generate).not.toHaveBeenCalled();
    });

    it('hashes the password before persisting', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.hash).toHaveBeenCalledOnce();
      expect(ctx.hash).toHaveBeenCalledWith(input.password);
    });

    it('saves a pending user, not an active one', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.txSave).toHaveBeenCalledOnce();
      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.id).toBe('new-user-id');
      expect(savedUser.status).toBe(UserStatus.Pending);
      expect(savedUser.isActive).toBe(false);
    });

    it('stages the UserCreatedEvent inside the transaction', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.stage).toHaveBeenCalledOnce();
      const [stagedEvents] = ctx.stage.mock.calls[0]!;
      expect(stagedEvents).toHaveLength(1);
      expect(stagedEvents[0]).toBeInstanceOf(UserCreatedEvent);
      expect((stagedEvents[0] as UserCreatedEvent).aggregateId).toBe('new-user-id');
    });

    it('issues one code bound to the new user in the same transaction', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.txCreateCode).toHaveBeenCalledOnce();
      const [savedCode] = ctx.txCreateCode.mock.calls[0]!;
      expect(savedCode.id).toBe('new-code-id');
      expect(savedCode.userId).toBe('new-user-id');
      expect(savedCode.attempts).toBe(0);
      expect(savedCode.maxAttempts).toBe(MAX_ATTEMPTS);
      expect(savedCode.consumedAt).toBeNull();
    });

    // The plaintext code must exist only in the job payload and the email.
    it('persists only the HMAC, never the plaintext code', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      const [savedCode] = ctx.txCreateCode.mock.calls[0]!;
      expect(savedCode.codeHash).toBe(CODE_HASH);
      expect(savedCode.codeHash).not.toBe(RAW_CODE);
      expect(ctx.codeService.hash).toHaveBeenCalledWith(RAW_CODE);
    });

    it('derives expiry from the configured TTL and one clock reading', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      const [savedCode] = ctx.txCreateCode.mock.calls[0]!;
      expect(savedCode.createdAt).toEqual(NOW);
      expect(savedCode.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1000));
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });

    it('enqueues the verification email exactly once with the plaintext code', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.enqueue).toHaveBeenCalledOnce();
      expect(ctx.enqueue).toHaveBeenCalledWith(SEND_VERIFICATION_EMAIL_JOB, {
        email: 'jane@example.com',
        code: RAW_CODE,
      });
    });

    it('enqueues after the transaction commits', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.txCreateCode.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    // A rolled-back transaction must never mail a code for a user that does not exist.
    it('does not enqueue when the transaction fails', async () => {
      ctx.run.mockRejectedValue(new Error('deadlock'));

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('returns a pending UserDto', async () => {
      const result = await new RegisterUser(ctx.deps).execute(input);

      expect(result.id).toBe('new-user-id');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe(UserStatus.Pending);
    });

    it('leaks no plaintext code through the response', async () => {
      const result = await new RegisterUser(ctx.deps).execute(input);

      expect(JSON.stringify(result)).not.toContain(RAW_CODE);
    });
  });
});
