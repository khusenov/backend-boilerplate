import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { RegisterUser } from './register-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { UserStatus } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';
import { makeUser } from '@test/unit/support/builders';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 900;
const MAX_ATTEMPTS = 5;
const RAW_CODE = '123456';
const CODE_HASH = 'hmac-of-123456';

function makeDeps() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.userRepository.save.mockResolvedValue(undefined);
  context.emailVerificationCodeRepository.create.mockResolvedValue(undefined);

  const userRepository = mock<UserRepository>();
  userRepository.findByEmail.mockResolvedValue(null);

  const passwordHasher = mock<PasswordHasher>();
  passwordHasher.hash.mockResolvedValue('hashed-secret');

  const idGenerator = mock<IdGenerator>();
  idGenerator.generate.mockReturnValue('new-user-id');

  const jobQueue = mock<JobQueue>();
  jobQueue.enqueue.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);

  const issuedCode = EmailVerificationCode.issue(
    {
      id: 'new-code-id',
      userId: 'new-user-id',
      codeHash: CODE_HASH,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
      maxAttempts: MAX_ATTEMPTS,
    },
    NOW,
  );
  const verificationCodeIssuer = mock<VerificationCodeIssuer>();
  verificationCodeIssuer.issue.mockReturnValue({ code: issuedCode, rawCode: RAW_CODE });

  const deps = {
    unitOfWork,
    userRepository,
    passwordHasher,
    verificationCodeIssuer,
    jobQueue,
    idGenerator,
    clock,
  };

  return { deps, tx: context, issuedCode };
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

      expect(ctx.deps.userRepository.findByEmail).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email before hashing the password', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(makeUser({ id: 'user-existing' }));

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.deps.passwordHasher.hash).not.toHaveBeenCalled();
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
    });

    it('never enqueues an email for a duplicate registration', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(makeUser({ id: 'user-existing' }));

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
      expect(ctx.deps.verificationCodeIssuer.issue).not.toHaveBeenCalled();
    });

    it('hashes the password before persisting', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.deps.passwordHasher.hash).toHaveBeenCalledOnce();
      expect(ctx.deps.passwordHasher.hash).toHaveBeenCalledWith(input.password);
    });

    it('saves a pending user, not an active one', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.tx.userRepository.save).toHaveBeenCalledOnce();
      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.id).toBe('new-user-id');
      expect(savedUser.status).toBe(UserStatus.Pending);
      expect(savedUser.isActive).toBe(false);
    });

    it('stages the UserCreatedEvent inside the transaction', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.tx.outbox.stage).toHaveBeenCalledOnce();
      const [stagedEvents] = ctx.tx.outbox.stage.mock.calls[0]!;
      expect(stagedEvents).toHaveLength(1);
      expect(stagedEvents[0]).toBeInstanceOf(UserCreatedEvent);
      expect((stagedEvents[0] as UserCreatedEvent).aggregateId).toBe('new-user-id');
    });

    it('issues a code for the new user and persists exactly what the issuer returned', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.deps.verificationCodeIssuer.issue).toHaveBeenCalledWith('new-user-id', NOW);
      expect(ctx.deps.unitOfWork.run).toHaveBeenCalledOnce();
      expect(ctx.tx.emailVerificationCodeRepository.create).toHaveBeenCalledWith(ctx.issuedCode);
    });

    it('reads the clock once and reuses it for the user and the code', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.deps.clock.now).toHaveBeenCalledOnce();
    });

    it('enqueues the verification email exactly once with the plaintext code', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledOnce();
      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledWith(SEND_VERIFICATION_EMAIL_JOB, {
        email: 'jane@example.com',
        code: RAW_CODE,
      });
    });

    it('enqueues after the transaction commits', async () => {
      await new RegisterUser(ctx.deps).execute(input);

      expect(
        ctx.tx.emailVerificationCodeRepository.create.mock.invocationCallOrder[0]!,
      ).toBeLessThan(ctx.deps.jobQueue.enqueue.mock.invocationCallOrder[0]!);
    });

    // A rolled-back transaction must never mail a code for a user that does not exist.
    it('does not enqueue when the transaction fails', async () => {
      ctx.deps.unitOfWork.run.mockRejectedValue(new Error('deadlock'));

      await expect(new RegisterUser(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
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
