import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { VerifyEmail } from './verify-email';
import { Email, InvalidEmailError } from '@/domain/user/email-vo';
import { User, UserStatus } from '@/domain/user/user-entity';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import {
  TooManyVerificationAttemptsError,
  VerificationCodeExpiredError,
  VerificationCodeInvalidError,
} from '@/domain/verification/verification-errors';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:05:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:15:00.000Z');
const MAX_ATTEMPTS = 5;
const RIGHT_CODE = '123456';
const WRONG_CODE = '999999';

function makePendingUser(): User {
  return User.hydrate({
    id: 'user-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-pw',
    status: UserStatus.Pending,
    version: 1,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    deletedAt: null,
  });
}

function makeCode(
  overrides: Partial<Parameters<typeof EmailVerificationCode.hydrate>[0]> = {},
): EmailVerificationCode {
  return EmailVerificationCode.hydrate({
    id: 'code-1',
    userId: 'user-1',
    codeHash: `hmac-of-${RIGHT_CODE}`,
    expiresAt: EXPIRES_AT,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
    deletedAt: null,
    ...overrides,
  });
}

function makeDeps() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.userRepository.save.mockResolvedValue(undefined);
  context.emailVerificationCodeRepository.update.mockResolvedValue(undefined);

  const user = makePendingUser();
  const userRepository = mock<UserRepository>();
  userRepository.findByEmail.mockResolvedValue(user);

  const emailVerificationCodeRepository = mock<EmailVerificationCodeRepository>();
  emailVerificationCodeRepository.findActiveByUserId.mockResolvedValue(makeCode());
  emailVerificationCodeRepository.update.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);
  const codeService = {
    generate: vi.fn<VerificationCodeService['generate']>(),
    hash: vi.fn<VerificationCodeService['hash']>().mockImplementation((code) => `hmac-of-${code}`),
  } satisfies VerificationCodeService;

  const deps = {
    unitOfWork,
    userRepository,
    emailVerificationCodeRepository,
    verificationCodeService: codeService,
    clock,
  };

  return { deps, tx: context, user };
}

async function rejectionOf(promise: Promise<unknown>): Promise<VerificationCodeInvalidError> {
  try {
    await promise;
  } catch (error) {
    return error as VerificationCodeInvalidError;
  }
  throw new Error('expected the call to reject');
}

describe('VerifyEmail', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  describe('execute', () => {
    it('throws InvalidEmailError for a malformed email before any lookup', async () => {
      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'not-an-email', code: RIGHT_CODE }),
      ).rejects.toThrow(InvalidEmailError);

      expect(ctx.deps.userRepository.findByEmail).not.toHaveBeenCalled();
    });

    it('looks the code up by the resolved user id', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.deps.emailVerificationCodeRepository.findActiveByUserId).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('hashes the candidate rather than comparing plaintext', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.deps.verificationCodeService.hash).toHaveBeenCalledWith(RIGHT_CODE);
    });

    it('activates the user and consumes the code in one transaction', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.deps.unitOfWork.run).toHaveBeenCalledOnce();
      expect(ctx.tx.userRepository.save).toHaveBeenCalledOnce();
      expect(ctx.tx.emailVerificationCodeRepository.update).toHaveBeenCalledOnce();

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.status).toBe(UserStatus.Active);
      expect(savedUser.updatedAt).toEqual(NOW);

      const [savedCode] = ctx.tx.emailVerificationCodeRepository.update.mock.calls[0]!;
      expect(savedCode.isConsumed).toBe(true);
      expect(savedCode.consumedAt).toEqual(NOW);
    });

    it('returns an active UserDto', async () => {
      const result = await new VerifyEmail(ctx.deps).execute({
        email: 'jane@example.com',
        code: RIGHT_CODE,
      });

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe(UserStatus.Active);
    });

    it('does not write outside the transaction on success', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.deps.emailVerificationCodeRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('wrong code', () => {
    it('throws VerificationCodeInvalidError', async () => {
      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);
    });

    it('persists the incremented attempt counter outside the transaction', async () => {
      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.deps.emailVerificationCodeRepository.update).toHaveBeenCalledOnce();
      const [savedCode] = ctx.deps.emailVerificationCodeRepository.update.mock.calls[0]!;
      expect(savedCode.attempts).toBe(1);
      expect(savedCode.isConsumed).toBe(false);
    });

    it('never activates the user', async () => {
      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
      expect(ctx.user.status).toBe(UserStatus.Pending);
    });
  });

  // Only the mismatch branch mutates the entity, so every other rejection must
  // avoid a pointless UPDATE.
  describe('rejections that write nothing', () => {
    it('throws VerificationCodeExpiredError for an expired code', async () => {
      ctx.deps.emailVerificationCodeRepository.findActiveByUserId.mockResolvedValue(
        makeCode({ expiresAt: new Date('2026-01-01T00:01:00.000Z') }),
      );

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeExpiredError);

      expect(ctx.deps.emailVerificationCodeRepository.update).not.toHaveBeenCalled();
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
    });

    it('throws TooManyVerificationAttemptsError once the cap is reached', async () => {
      ctx.deps.emailVerificationCodeRepository.findActiveByUserId.mockResolvedValue(
        makeCode({ attempts: MAX_ATTEMPTS }),
      );

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(TooManyVerificationAttemptsError);

      expect(ctx.deps.emailVerificationCodeRepository.update).not.toHaveBeenCalled();
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
    });
  });

  // A caller must not be able to tell an unknown account from a wrong code.
  describe('account enumeration', () => {
    it('throws VerificationCodeInvalidError for an unknown email', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(null);

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'nobody@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.deps.emailVerificationCodeRepository.findActiveByUserId).not.toHaveBeenCalled();
      expect(ctx.deps.verificationCodeService.hash).not.toHaveBeenCalled();
    });

    it('throws VerificationCodeInvalidError when no active code exists', async () => {
      ctx.deps.emailVerificationCodeRepository.findActiveByUserId.mockResolvedValue(null);

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.deps.verificationCodeService.hash).not.toHaveBeenCalled();
    });

    it('reports the same error code and message for an unknown email and a wrong code', async () => {
      const wrong = await rejectionOf(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      );

      ctx = makeDeps();
      ctx.deps.userRepository.findByEmail.mockResolvedValue(null);
      const unknown = await rejectionOf(
        new VerifyEmail(ctx.deps).execute({ email: 'nobody@example.com', code: RIGHT_CODE }),
      );

      expect(unknown.code).toBe(wrong.code);
      expect(unknown.message).toBe(wrong.message);
    });
  });
});
