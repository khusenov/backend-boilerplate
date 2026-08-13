import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingJobQueue, createHarness, resetDb, type TestHarness } from './support/harness';
import { seedUser } from './support/factories';
import {
  SEND_PASSWORD_RESET_EMAIL_JOB,
  type SendPasswordResetEmailPayload,
} from '@/application/jobs/send-password-reset-email-job';
import {
  REVOKE_USER_SESSIONS_JOB,
  type RevokeUserSessionsPayload,
} from '@/application/jobs/revoke-user-sessions-job';

const NEW_PASSWORD = 'BrandNewPass1';

interface ErrorBody {
  error: { code: string };
}

describe('/auth/forgot-password + /auth/reset-password (integration)', () => {
  let h: TestHarness;
  let queue: CapturingJobQueue;

  // Same rationale as verify-email.int.test.ts: the plaintext token is never
  // persisted, so a capturing queue is the only place a test can read it, and it
  // keeps the suite off the real BullMQ worker.
  beforeAll(async () => {
    queue = new CapturingJobQueue();
    h = await createHarness({ jobQueue: queue });
  });

  afterAll(async () => {
    await h.app.close();
  });

  afterEach(async () => {
    await resetDb(h.prisma);
    queue.enqueued.length = 0;
  });

  function forgotPassword(email: string) {
    return h.app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email },
    });
  }

  function resetPassword(token: string, newPassword: string) {
    return h.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword },
    });
  }

  function login(email: string, password: string) {
    return h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
  }

  async function registerPendingUser(email: string): Promise<void> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { firstName: 'Pend', lastName: 'Ing', email, password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
  }

  async function requestResetToken(email: string): Promise<string> {
    const res = await forgotPassword(email);
    expect(res.statusCode).toBe(204);

    const job = queue.enqueued.at(-1);
    expect(job?.jobName).toBe(SEND_PASSWORD_RESET_EMAIL_JOB);
    return (job?.payload as SendPasswordResetEmailPayload).token;
  }

  describe('POST /forgot-password', () => {
    it('enqueues a token that is not what the database stores', async () => {
      const user = await seedUser(h.app, { email: 'forgot@finflow.test' });

      const token = await requestResetToken(user.email);

      const rows = await h.prisma.passwordResetToken.findMany({ where: { userId: user.id } });
      expect(rows[0]?.tokenHash).not.toBe(token);
    });

    it('is a silent 204 for an unregistered email, with no job captured', async () => {
      const res = await forgotPassword('nobody@finflow.test');

      expect(res.statusCode).toBe(204);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('is a silent 204 for a soft-deleted user, with no job captured', async () => {
      const user = await seedUser(h.app, { email: 'deleted@finflow.test' });
      await h.prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

      const res = await forgotPassword(user.email);

      expect(res.statusCode).toBe(204);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('rejects invalid input (400)', async () => {
      const res = await forgotPassword('not-an-email');
      expect(res.statusCode).toBe(400);
    });

    it('a repeat request supersedes the first token (invalidateAllForUser end-to-end)', async () => {
      const user = await seedUser(h.app, { email: 'repeat@finflow.test' });

      const firstToken = await requestResetToken(user.email);
      const secondToken = await requestResetToken(user.email);
      expect(queue.enqueued).toHaveLength(2);

      const firstAttempt = await resetPassword(firstToken, NEW_PASSWORD);
      expect(firstAttempt.statusCode).toBe(400);
      expect(firstAttempt.json<ErrorBody>().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');

      const secondAttempt = await resetPassword(secondToken, NEW_PASSWORD);
      expect(secondAttempt.statusCode).toBe(204);
    });
  });

  describe('POST /reset-password', () => {
    it('resets an active user’s password, revokes sessions, and swaps which password logs in (204)', async () => {
      const user = await seedUser(h.app, { email: 'active-reset@finflow.test' });
      const token = await requestResetToken(user.email);

      const res = await resetPassword(token, NEW_PASSWORD);
      expect(res.statusCode).toBe(204);

      const job = queue.enqueued.at(-1);
      expect(job?.jobName).toBe(REVOKE_USER_SESSIONS_JOB);
      expect((job?.payload as RevokeUserSessionsPayload).userId).toBe(user.id);

      expect((await login(user.email, user.password)).statusCode).toBe(401);
      expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('activates a pending (never-verified) user on a successful reset', async () => {
      const email = 'pending-reset@finflow.test';
      await registerPendingUser(email);
      const token = await requestResetToken(email);

      expect((await resetPassword(token, NEW_PASSWORD)).statusCode).toBe(204);

      // Login gates on isActive, so this only succeeds if the reset also activated the account.
      expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('rejects an expired token (400)', async () => {
      const user = await seedUser(h.app, { email: 'expired-reset@finflow.test' });
      const { idGenerator, opaqueTokenService } = h.app.diContainer.cradle;
      const rawToken = opaqueTokenService.generate();
      const now = new Date();
      await h.prisma.passwordResetToken.create({
        data: {
          id: idGenerator.generate(),
          userId: user.id,
          tokenHash: opaqueTokenService.hash(rawToken),
          expiresAt: new Date(now.getTime() - 1000),
          usedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const res = await resetPassword(rawToken, NEW_PASSWORD);

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
    });

    it('rejects a replay of an already-used token (400)', async () => {
      const user = await seedUser(h.app, { email: 'replay-reset@finflow.test' });
      const token = await requestResetToken(user.email);
      expect((await resetPassword(token, NEW_PASSWORD)).statusCode).toBe(204);

      const replay = await resetPassword(token, 'AnotherNewPass2');

      expect(replay.statusCode).toBe(400);
      expect(replay.json<ErrorBody>().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    });

    it('rejects a well-formed but unknown token (400)', async () => {
      const res = await resetPassword('well-formed-but-unknown-token-value', NEW_PASSWORD);

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    });

    it('rejects a valid token whose user was soft-deleted after the token was issued (400)', async () => {
      const user = await seedUser(h.app, { email: 'deleted-after-issue@finflow.test' });
      const token = await requestResetToken(user.email);
      await h.prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

      const res = await resetPassword(token, NEW_PASSWORD);

      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    });

    it('rejects invalid input (400)', async () => {
      const res = await resetPassword('', 'short');
      expect(res.statusCode).toBe(400);
    });
  });
});
