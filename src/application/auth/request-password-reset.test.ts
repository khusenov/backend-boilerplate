import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestPasswordReset } from './request-password-reset';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import { SEND_PASSWORD_RESET_EMAIL_JOB } from '@/application/jobs/send-password-reset-email-job';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { PasswordResetTokenIssuer } from '@/application/auth/password-reset-token-issuer';
import type { Clock } from '@/application/shared/ports/clock';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TTL_SECONDS = 1800;
const RAW_TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'hmac-of-raw-opaque-token';

function makeActiveUser(): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: Email.create('jane@example.com'),
      passwordHash: 'hashed-pw',
    },
    NOW,
  );
}

function makePendingUser(): User {
  return User.register(
    {
      id: 'user-2',
      firstName: 'Pat',
      lastName: 'Pending',
      email: Email.create('pat@example.com'),
      passwordHash: 'hashed-pw',
    },
    NOW,
  );
}

function makeDeps() {
  const txInvalidate = vi
    .fn<PasswordResetTokenRepository['invalidateAllForUser']>()
    .mockResolvedValue(undefined);
  const txCreate = vi.fn<PasswordResetTokenRepository['create']>().mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({
      passwordResetTokenRepository: { invalidateAllForUser: txInvalidate, create: txCreate },
    } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const findByEmail = vi.fn<UserRepository['findByEmail']>().mockResolvedValue(makeActiveUser());
  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;
  const enqueue = vi.fn<JobQueue['enqueue']>().mockResolvedValue(undefined);

  const issuedToken = PasswordResetToken.issue(
    {
      id: 'reset-token-1',
      userId: 'user-1',
      tokenHash: TOKEN_HASH,
      expiresAt: new Date(NOW.getTime() + TTL_SECONDS * 1000),
    },
    NOW,
  );
  const issue = vi
    .fn<PasswordResetTokenIssuer['issue']>()
    .mockReturnValue({ token: issuedToken, rawToken: RAW_TOKEN });
  const passwordResetTokenIssuer = { issue } as unknown as PasswordResetTokenIssuer;

  const deps = {
    unitOfWork,
    userRepository: { findByEmail } as unknown as UserRepository,
    passwordResetTokenIssuer,
    jobQueue: { enqueue } as unknown as JobQueue,
    clock,
  };

  return {
    deps,
    run,
    findByEmail,
    enqueue,
    issue,
    issuedToken,
    clock,
    txInvalidate,
    txCreate,
  };
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

      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.txInvalidate).toHaveBeenCalledWith('user-1', NOW);
      expect(ctx.txCreate).toHaveBeenCalledWith(ctx.issuedToken);
      expect(ctx.txInvalidate.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.txCreate.mock.invocationCallOrder[0]!,
      );
    });

    it('issues a token for the resolved user', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.issue).toHaveBeenCalledWith('user-1', NOW);
    });

    it('enqueues the reset email with the raw token, not the hash', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.enqueue).toHaveBeenCalledOnce();
      expect(ctx.enqueue).toHaveBeenCalledWith(SEND_PASSWORD_RESET_EMAIL_JOB, {
        email: 'jane@example.com',
        token: RAW_TOKEN,
      });
    });

    it('enqueues after the transaction commits', async () => {
      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.txCreate.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    it('also issues a token for a pending (never-verified) user', async () => {
      ctx.findByEmail.mockResolvedValue(makePendingUser());

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.issue).toHaveBeenCalledWith('user-2', NOW);
      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.enqueue).toHaveBeenCalledOnce();
    });

    it('is a silent no-op for an unknown email', async () => {
      ctx.findByEmail.mockResolvedValue(null);

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.issue).not.toHaveBeenCalled();
      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a soft-deleted user, so it cannot be used to enumerate accounts', async () => {
      const deleted = makeActiveUser();
      deleted.softDelete(NOW);
      ctx.findByEmail.mockResolvedValue(deleted);

      await new RequestPasswordReset(ctx.deps).execute(input);

      expect(ctx.issue).not.toHaveBeenCalled();
      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue when the transaction fails', async () => {
      ctx.run.mockRejectedValue(new Error('deadlock'));

      await expect(new RequestPasswordReset(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.enqueue).not.toHaveBeenCalled();
    });
  });
});
