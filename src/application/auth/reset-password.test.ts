import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ResetPassword } from './reset-password';
import type { User } from '@/domain/user/user-entity';
import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import {
  PasswordResetTokenExpiredError,
  PasswordResetTokenInvalidError,
} from '@/domain/password-reset/password-reset-errors';
import { REVOKE_USER_SESSIONS_JOB } from '@/application/jobs/revoke-user-sessions-job';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import { makeRegisteredUser, makeUser } from '@test/unit/support/builders';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:10:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:30:00.000Z');
const RAW_TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'hmac-of-raw-opaque-token';
const NEW_PASSWORD_HASH = 'hashed-new-password';

function makeInactiveUser(): User {
  const user = makeUser({ passwordHash: 'old-hash' });
  user.deactivate(ISSUED_AT);
  return user;
}

function makeResetToken(overrides: { userId?: string; expiresAt?: Date } = {}): PasswordResetToken {
  return PasswordResetToken.issue(
    {
      id: 'reset-token-1',
      userId: overrides.userId ?? 'user-1',
      tokenHash: TOKEN_HASH,
      expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    },
    ISSUED_AT,
  );
}

function makeDeps() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.userRepository.save.mockResolvedValue(undefined);
  context.passwordResetTokenRepository.update.mockResolvedValue(undefined);

  const passwordResetTokenRepository = mock<PasswordResetTokenRepository>();
  passwordResetTokenRepository.findByTokenHash.mockResolvedValue(makeResetToken());

  const userRepository = mock<UserRepository>();
  userRepository.findById.mockResolvedValue(makeUser({ passwordHash: 'old-hash' }));

  const passwordHasher = mock<PasswordHasher>();
  passwordHasher.hash.mockResolvedValue(NEW_PASSWORD_HASH);

  const opaqueTokenService = mock<OpaqueTokenService>();
  opaqueTokenService.hash.mockReturnValue(TOKEN_HASH);

  const jobQueue = mock<JobQueue>();
  jobQueue.enqueue.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);

  const deps = {
    unitOfWork,
    userRepository,
    passwordResetTokenRepository,
    passwordHasher,
    opaqueTokenService,
    jobQueue,
    clock,
  };

  return { deps, tx: context };
}

const input = { token: RAW_TOKEN, newPassword: 'NewStr0ng!Pass' };

describe('ResetPassword', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  describe('execute', () => {
    it('hashes the presented token before lookup', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      expect(ctx.deps.opaqueTokenService.hash).toHaveBeenCalledWith(RAW_TOKEN);
      expect(ctx.deps.passwordResetTokenRepository.findByTokenHash).toHaveBeenCalledWith(
        TOKEN_HASH,
      );
    });

    it('hashes and saves the new password, and marks the token used', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      expect(ctx.deps.passwordHasher.hash).toHaveBeenCalledWith(input.newPassword);
      expect(ctx.tx.userRepository.save).toHaveBeenCalledOnce();
      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.passwordHash).toBe(NEW_PASSWORD_HASH);

      expect(ctx.tx.passwordResetTokenRepository.update).toHaveBeenCalledOnce();
      const [updatedToken] = ctx.tx.passwordResetTokenRepository.update.mock.calls[0]!;
      expect(updatedToken.isUsed).toBe(true);
      expect(updatedToken.usedAt).toEqual(NOW);
    });

    it('leaves an active user active', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.isActive).toBe(true);
    });

    it('enqueues session revocation for the resetting user after commit', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledOnce();
      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledWith(REVOKE_USER_SESSIONS_JOB, {
        userId: 'user-1',
      });
      expect(ctx.tx.userRepository.save.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.deps.jobQueue.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    it('activates a pending (never-verified) user on a successful reset', async () => {
      ctx.deps.userRepository.findById.mockResolvedValue(
        makeRegisteredUser({
          id: 'user-2',
          firstName: 'Pat',
          lastName: 'Pending',
          email: 'pat@example.com',
          passwordHash: 'old-hash',
        }),
      );
      ctx.deps.passwordResetTokenRepository.findByTokenHash.mockResolvedValue(
        makeResetToken({ userId: 'user-2' }),
      );

      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.isActive).toBe(true);
      expect(savedUser.isPending).toBe(false);
    });

    it('changes the password but leaves a deactivated user inactive', async () => {
      ctx.deps.userRepository.findById.mockResolvedValue(makeInactiveUser());

      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.passwordHash).toBe(NEW_PASSWORD_HASH);
      expect(savedUser.isActive).toBe(false);
    });

    it('rejects an unknown token hash without writing or enqueueing anything', async () => {
      ctx.deps.passwordResetTokenRepository.findByTokenHash.mockResolvedValue(null);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('rejects an expired token without writing anything', async () => {
      ctx.deps.passwordResetTokenRepository.findByTokenHash.mockResolvedValue(
        makeResetToken({ expiresAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenExpiredError,
      );

      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('rejects an already-used token (double submit)', async () => {
      const used = makeResetToken();
      used.consume(ISSUED_AT);
      ctx.deps.passwordResetTokenRepository.findByTokenHash.mockResolvedValue(used);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
    });

    it('rejects a valid token whose user was soft-deleted, without consuming the token', async () => {
      const token = makeResetToken();
      ctx.deps.passwordResetTokenRepository.findByTokenHash.mockResolvedValue(token);
      ctx.deps.userRepository.findById.mockResolvedValue(null);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(token.isUsed).toBe(false);
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
    });

    it('does not enqueue session revocation when the transaction fails', async () => {
      ctx.deps.unitOfWork.run.mockRejectedValue(new Error('deadlock'));

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });
  });
});
