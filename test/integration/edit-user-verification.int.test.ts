import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingJobQueue, createHarness, resetDb, type TestHarness } from './support/harness';
import { authHeader, seedUser } from './support/factories';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';

describe('PATCH /users/:id email re-verification (integration)', () => {
  let h: TestHarness;
  let queue: CapturingJobQueue;

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

  it('demotes the user to pending and enqueues a fresh verification code', async () => {
    const actor = await seedUser(h.app, { email: 'before@example.test' });
    const auth = await authHeader(h.app, actor);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${actor.id}`,
      headers: auth,
      payload: { email: 'after@example.test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('pending');

    const job = queue.enqueued.at(-1);
    expect(job?.jobName).toBe(SEND_VERIFICATION_EMAIL_JOB);
    expect((job?.payload as SendVerificationEmailPayload).email).toBe('after@example.test');
  });

  it('reissues the same code row on a second email change before verifying', async () => {
    const actor = await seedUser(h.app, { email: 'before@example.test' });
    const auth = await authHeader(h.app, actor);

    await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${actor.id}`,
      headers: auth,
      payload: { email: 'middle@example.test' },
    });
    await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${actor.id}`,
      headers: auth,
      payload: { email: 'after@example.test' },
    });

    const rows = await h.prisma.emailVerificationCode.findMany({ where: { userId: actor.id } });
    expect(rows).toHaveLength(1);
  });

  it('lets the user complete verification with the code issued after an email change', async () => {
    const actor = await seedUser(h.app, { email: 'before@example.test' });
    const auth = await authHeader(h.app, actor);

    await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${actor.id}`,
      headers: auth,
      payload: { email: 'after@example.test' },
    });

    const job = queue.enqueued.at(-1);
    const { code } = job?.payload as SendVerificationEmailPayload;

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { email: 'after@example.test', code },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('active');
  });
});
