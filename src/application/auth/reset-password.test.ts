import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetPassword } from './reset-password';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import {
  PasswordResetTokenExpiredError,
  PasswordResetTokenInvalidError,
} from '@/domain/password-reset/password-reset-errors';
import { REVOKE_USER_SESSIONS_JOB } from '@/application/jobs/revoke-user-sessions-job';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Clock } from '@/application/shared/ports/clock';

const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:10:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:30:00.000Z');
const RAW_TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'hmac-of-raw-opaque-token';
const NEW_PASSWORD_HASH = 'hashed-new-password';

function makeActiveUser(): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: Email.create('jane@example.com'),
      passwordHash: 'old-hash',
    },
    ISSUED_AT,
  );
}

function makePendingUser(): User {
  return User.register(
    {
      id: 'user-2',
      firstName: 'Pat',
      lastName: 'Pending',
      email: Email.create('pat@example.com'),
      passwordHash: 'old-hash',
    },
    ISSUED_AT,
  );
}

function makeInactiveUser(): User {
  const user = makeActiveUser();
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
  const txSave = vi.fn<UserRepository['save']>().mockResolvedValue(undefined);
  const txUpdateToken = vi
    .fn<PasswordResetTokenRepository['update']>()
    .mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({
      userRepository: { save: txSave },
      passwordResetTokenRepository: { update: txUpdateToken },
    } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const findByTokenHash = vi
    .fn<PasswordResetTokenRepository['findByTokenHash']>()
    .mockResolvedValue(makeResetToken());
  const findById = vi.fn<UserRepository['findById']>().mockResolvedValue(makeActiveUser());
  const hash = vi.fn<PasswordHasher['hash']>().mockResolvedValue(NEW_PASSWORD_HASH);
  const hashToken = vi.fn<OpaqueTokenService['hash']>().mockReturnValue(TOKEN_HASH);
  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;
  const enqueue = vi.fn<JobQueue['enqueue']>().mockResolvedValue(undefined);

  const deps = {
    unitOfWork,
    userRepository: { findById } as unknown as UserRepository,
    passwordResetTokenRepository: { findByTokenHash } as unknown as PasswordResetTokenRepository,
    passwordHasher: { hash } as unknown as PasswordHasher,
    opaqueTokenService: { hash: hashToken, generate: vi.fn() } as unknown as OpaqueTokenService,
    jobQueue: { enqueue } as unknown as JobQueue,
    clock,
  };

  return {
    deps,
    run,
    findByTokenHash,
    findById,
    hash,
    hashToken,
    enqueue,
    clock,
    txSave,
    txUpdateToken,
  };
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

      expect(ctx.hashToken).toHaveBeenCalledWith(RAW_TOKEN);
      expect(ctx.findByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    });

    it('hashes and saves the new password, and marks the token used', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      expect(ctx.hash).toHaveBeenCalledWith(input.newPassword);
      expect(ctx.txSave).toHaveBeenCalledOnce();
      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.passwordHash).toBe(NEW_PASSWORD_HASH);

      expect(ctx.txUpdateToken).toHaveBeenCalledOnce();
      const [updatedToken] = ctx.txUpdateToken.mock.calls[0]!;
      expect(updatedToken.isUsed).toBe(true);
      expect(updatedToken.usedAt).toEqual(NOW);
    });

    it('leaves an active user active', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.isActive).toBe(true);
    });

    it('enqueues session revocation for the resetting user after commit', async () => {
      await new ResetPassword(ctx.deps).execute(input);

      expect(ctx.enqueue).toHaveBeenCalledOnce();
      expect(ctx.enqueue).toHaveBeenCalledWith(REVOKE_USER_SESSIONS_JOB, { userId: 'user-1' });
      expect(ctx.txSave.mock.invocationCallOrder[0]!).toBeLessThan(
        ctx.enqueue.mock.invocationCallOrder[0]!,
      );
    });

    it('activates a pending (never-verified) user on a successful reset', async () => {
      ctx.findById.mockResolvedValue(makePendingUser());
      ctx.findByTokenHash.mockResolvedValue(makeResetToken({ userId: 'user-2' }));

      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.isActive).toBe(true);
      expect(savedUser.isPending).toBe(false);
    });

    it('changes the password but leaves a deactivated user inactive', async () => {
      ctx.findById.mockResolvedValue(makeInactiveUser());

      await new ResetPassword(ctx.deps).execute(input);

      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.passwordHash).toBe(NEW_PASSWORD_HASH);
      expect(savedUser.isActive).toBe(false);
    });

    it('rejects an unknown token hash without writing or enqueueing anything', async () => {
      ctx.findByTokenHash.mockResolvedValue(null);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('rejects an expired token without writing anything', async () => {
      ctx.findByTokenHash.mockResolvedValue(
        makeResetToken({ expiresAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenExpiredError,
      );

      expect(ctx.run).not.toHaveBeenCalled();
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it('rejects an already-used token (double submit)', async () => {
      const used = makeResetToken();
      used.consume(ISSUED_AT);
      ctx.findByTokenHash.mockResolvedValue(used);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(ctx.run).not.toHaveBeenCalled();
    });

    it('rejects a valid token whose user was soft-deleted, without consuming the token', async () => {
      const token = makeResetToken();
      ctx.findByTokenHash.mockResolvedValue(token);
      ctx.findById.mockResolvedValue(null);

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        PasswordResetTokenInvalidError,
      );

      expect(token.isUsed).toBe(false);
      expect(ctx.run).not.toHaveBeenCalled();
    });

    it('does not enqueue session revocation when the transaction fails', async () => {
      ctx.run.mockRejectedValue(new Error('deadlock'));

      await expect(new ResetPassword(ctx.deps).execute(input)).rejects.toThrow('deadlock');

      expect(ctx.enqueue).not.toHaveBeenCalled();
    });
  });
});
