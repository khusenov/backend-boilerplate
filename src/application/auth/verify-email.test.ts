import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmail } from './verify-email';
import { Email, InvalidEmailError } from '@/domain/user/email-vo';
import { User, UserStatus } from '@/domain/user/user-entity';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import {
  TooManyVerificationAttemptsError,
  VerificationCodeExpiredError,
  VerificationCodeInvalidError,
} from '@/domain/verification/verification-errors';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { Clock } from '@/application/shared/ports/clock';

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
  const txSave = vi.fn<UserRepository['save']>().mockResolvedValue(undefined);
  const txUpdateCode = vi
    .fn<EmailVerificationCodeRepository['update']>()
    .mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({
      userRepository: { save: txSave },
      emailVerificationCodeRepository: { update: txUpdateCode },
    } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const user = makePendingUser();
  const findByEmail = vi.fn<UserRepository['findByEmail']>().mockResolvedValue(user);
  const findActiveByUserId = vi
    .fn<EmailVerificationCodeRepository['findActiveByUserId']>()
    .mockResolvedValue(makeCode());
  const updateCode = vi
    .fn<EmailVerificationCodeRepository['update']>()
    .mockResolvedValue(undefined);
  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;
  const codeService = {
    generate: vi.fn<VerificationCodeService['generate']>(),
    hash: vi.fn<VerificationCodeService['hash']>().mockImplementation((code) => `hmac-of-${code}`),
  } satisfies VerificationCodeService;

  const deps = {
    unitOfWork,
    userRepository: { findByEmail } as unknown as UserRepository,
    emailVerificationCodeRepository: {
      findActiveByUserId,
      update: updateCode,
    } as unknown as EmailVerificationCodeRepository,
    verificationCodeService: codeService,
    clock,
  };

  return {
    deps,
    run,
    user,
    findByEmail,
    findActiveByUserId,
    updateCode,
    codeService,
    txSave,
    txUpdateCode,
  };
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

      expect(ctx.findByEmail).not.toHaveBeenCalled();
    });

    it('looks the code up by the resolved user id', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.findActiveByUserId).toHaveBeenCalledWith('user-1');
    });

    it('hashes the candidate rather than comparing plaintext', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.codeService.hash).toHaveBeenCalledWith(RIGHT_CODE);
    });

    it('activates the user and consumes the code in one transaction', async () => {
      await new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE });

      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.txSave).toHaveBeenCalledOnce();
      expect(ctx.txUpdateCode).toHaveBeenCalledOnce();

      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.status).toBe(UserStatus.Active);
      expect(savedUser.updatedAt).toEqual(NOW);

      const [savedCode] = ctx.txUpdateCode.mock.calls[0]!;
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

      expect(ctx.updateCode).not.toHaveBeenCalled();
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
      ).rejects.toThrow();

      expect(ctx.updateCode).toHaveBeenCalledOnce();
      const [savedCode] = ctx.updateCode.mock.calls[0]!;
      expect(savedCode.attempts).toBe(1);
      expect(savedCode.isConsumed).toBe(false);
    });

    it('never activates the user', async () => {
      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      ).rejects.toThrow();

      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.user.status).toBe(UserStatus.Pending);
    });
  });

  // Only the mismatch branch mutates the entity, so every other rejection must
  // avoid a pointless UPDATE.
  describe('rejections that write nothing', () => {
    it('throws VerificationCodeExpiredError for an expired code', async () => {
      ctx.findActiveByUserId.mockResolvedValue(
        makeCode({ expiresAt: new Date('2026-01-01T00:01:00.000Z') }),
      );

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeExpiredError);

      expect(ctx.updateCode).not.toHaveBeenCalled();
      expect(ctx.run).not.toHaveBeenCalled();
    });

    it('throws TooManyVerificationAttemptsError once the cap is reached', async () => {
      ctx.findActiveByUserId.mockResolvedValue(makeCode({ attempts: MAX_ATTEMPTS }));

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(TooManyVerificationAttemptsError);

      expect(ctx.updateCode).not.toHaveBeenCalled();
      expect(ctx.run).not.toHaveBeenCalled();
    });
  });

  // A caller must not be able to tell an unknown account from a wrong code.
  describe('account enumeration', () => {
    it('throws VerificationCodeInvalidError for an unknown email', async () => {
      ctx.findByEmail.mockResolvedValue(null);

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'nobody@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.findActiveByUserId).not.toHaveBeenCalled();
      expect(ctx.codeService.hash).not.toHaveBeenCalled();
    });

    it('throws VerificationCodeInvalidError when no active code exists', async () => {
      ctx.findActiveByUserId.mockResolvedValue(null);

      await expect(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: RIGHT_CODE }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidError);

      expect(ctx.codeService.hash).not.toHaveBeenCalled();
    });

    it('reports the same error code and message for an unknown email and a wrong code', async () => {
      const wrong = await rejectionOf(
        new VerifyEmail(ctx.deps).execute({ email: 'jane@example.com', code: WRONG_CODE }),
      );

      ctx = makeDeps();
      ctx.findByEmail.mockResolvedValue(null);
      const unknown = await rejectionOf(
        new VerifyEmail(ctx.deps).execute({ email: 'nobody@example.com', code: RIGHT_CODE }),
      );

      expect(unknown.code).toBe(wrong.code);
      expect(unknown.message).toBe(wrong.message);
    });
  });
});
