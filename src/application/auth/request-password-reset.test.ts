import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { RequestPasswordReset } from './request-password-reset';
import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import { SEND_PASSWORD_RESET_EMAIL_JOB } from '@/application/jobs/send-password-reset-email-job';
import type { UserRepository } from '@/domain/user/user-repository';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { PasswordResetTokenIssuer } from '@/application/auth/password-reset-token-issuer';
import { makeRegisteredUser, makeUser } from '@test/unit/support/builders';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 1800;
const RAW_TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'hmac-of-raw-opaque-token';

function makeDeps() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.passwordResetTokenRepository.invalidateAllForUser.mockResolvedValue(undefined);
  context.passwordResetTokenRepository.create.mockResolvedValue(undefined);

  const userRepository = mock<UserRepository>();
  userRepository.findByEmail.mockResolvedValue(makeUser());

  const jobQueue = mock<JobQueue>();
  jobQueue.enqueue.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);

  const issuedToken = PasswordResetToken.issue(
    {
      id: 'reset-token-1',
      userId: 'user-1',
      tokenHash: TOKEN_HASH,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    },
    NOW,
  );
  const passwordResetTokenIssuer = mock<PasswordResetTokenIssuer>();
  passwordResetTokenIssuer.issue.mockReturnValue({ token: issuedToken, rawToken: RAW_TOKEN });

  const deps = { unitOfWork, userRepository, passwordResetTokenIssuer, jobQueue, clock };

  return { deps, tx: context, issuedToken };
}

const input = { email: 'jane@example.com' };

describe('RequestPasswordReset', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  describe('execute', () => {
    it('invalidates prior tokens before creating the new one, inside one transaction', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.unitOfWork.run).toHaveBeenCalledOnce();
      expect(ctx.tx.passwordResetTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
        'user-1',
        NOW,
      );
      expect(ctx.tx.passwordResetTokenRepository.create).toHaveBeenCalledWith(ctx.issuedToken);
      expect(
        ctx.tx.passwordResetTokenRepository.invalidateAllForUser.mock.invocationCallOrder[0]!,
      ).toBeLessThan(ctx.tx.passwordResetTokenRepository.create.mock.invocationCallOrder[0]!);
    });

    it('issues a token for the resolved user', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.passwordResetTokenIssuer.issue).toHaveBeenCalledWith('user-1', NOW);
    });

    it('enqueues the reset email with the raw token, not the hash', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledOnce();
      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledWith(SEND_PASSWORD_RESET_EMAIL_JOB, {
        email: 'jane@example.com',
        token: RAW_TOKEN,
      });
    });

    it('enqueues after the transaction commits', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.tx.passwordResetTokenRepository.create.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.deps.jobQueue.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    it('also issues a token for a pending (never-verified) user', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(
        makeRegisteredUser({
          id: 'user-2',
          firstName: 'Pat',
          lastName: 'Pending',
          email: 'pat@example.com',
        }),
      );

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.passwordResetTokenIssuer.issue).toHaveBeenCalledWith('user-2', NOW);
      expect(ctx.deps.unitOfWork.run).toHaveBeenCalledOnce();
      expect(ctx.deps.jobQueue.enqueue).toHaveBeenCalledOnce();
    });

    it('is a silent no-op for an unknown email', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(null);

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.passwordResetTokenIssuer.issue).not.toHaveBeenCalled();
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a soft-deleted user, so it cannot be used to enumerate accounts', async () => {
      const deleted = makeUser();
      deleted.softDelete(NOW);
      ctx.deps.userRepository.findByEmail.mockResolvedValue(deleted);

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.deps.passwordResetTokenIssuer.issue).not.toHaveBeenCalled();
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue when the transaction fails', async () => {
      ctx.deps.unitOfWork.run.mockRejectedValue(new Error('deadlock'));

      await expect(new RequestPasswordReset(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.deps.jobQueue.enqueue).not.toHaveBeenCalled();
    });
  });
});
