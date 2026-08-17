import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingJobQueue, createHarness, resetDb, type TestHarness } from './support/harness';
import { env } from '@/config/env';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';

const PASSWORD = 'password123';

interface ErrorBody {
  error: { code: string };
}

function anyCodeOtherThan(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

describe('/auth/verify-email (integration)', () => {
  let h: TestHarness;
  let queue: CapturingJobQueue;

  // The plaintext code is never persisted, so the only place a test can read it
  // is the enqueue boundary. Binding a capturing queue also keeps the suite off
  // the real BullMQ worker.
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

  async function register(email: string): Promise<{ id: string; code: string }> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { firstName: 'Ver', lastName: 'Ify', email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);

    const job = queue.enqueued.at(-1);
    expect(job?.jobName).toBe(SEND_VERIFICATION_EMAIL_JOB);
    const payload = job?.payload as SendVerificationEmailPayload;
    expect(payload.email).toBe(email);

    return { id: res.json<{ id: string }>().id, code: payload.code };
  }

  function verify(email: string, code: string) {
    return h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { email, code },
    });
  }

  it('enqueues a six-digit code that is not what the database stores', async () => {
    const { id, code } = await register('shape@example.test');

    expect(code).toMatch(/^\d{6}$/);
    const rows = await h.prisma.emailVerificationCode.findMany({ where: { userId: id } });
    expect(rows[0]?.codeHash).not.toBe(code);
  });

  it('activates the account and consumes the code (200)', async () => {
    const { id, code } = await register('verify@example.test');

    const res = await verify('verify@example.test', code);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('active');

    const persisted = await h.prisma.user.findUnique({ where: { id } });
    expect(persisted?.status).toBe('active');

    const rows = await h.prisma.emailVerificationCode.findMany({ where: { userId: id } });
    expect(rows[0]?.consumedAt).not.toBeNull();
  });

  it('rejects a replay of an already-consumed code (400)', async () => {
    const { code } = await register('replay@example.test');
    expect((await verify('replay@example.test', code)).statusCode).toBe(200);

    const replay = await verify('replay@example.test', code);

    expect(replay.statusCode).toBe(400);
    expect(replay.json<ErrorBody>().error.code).toBe('VERIFICATION_CODE_INVALID');
  });

  it('rejects a wrong code and records the attempt (400)', async () => {
    const { id, code } = await register('wrong@example.test');

    const res = await verify('wrong@example.test', anyCodeOtherThan(code));

    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('VERIFICATION_CODE_INVALID');

    const rows = await h.prisma.emailVerificationCode.findMany({ where: { userId: id } });
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.consumedAt).toBeNull();
  });

  it('locks the code once the attempt cap is reached (400)', async () => {
    const { id, code } = await register('capped@example.test');
    const wrong = anyCodeOtherThan(code);

    for (let i = 0; i < env.VERIFICATION_MAX_ATTEMPTS; i++) {
      const res = await verify('capped@example.test', wrong);
      expect(res.json<ErrorBody>().error.code).toBe('VERIFICATION_CODE_INVALID');
    }

    const capped = await verify('capped@example.test', wrong);

    expect(capped.statusCode).toBe(400);
    expect(capped.json<ErrorBody>().error.code).toBe('TOO_MANY_VERIFICATION_ATTEMPTS');

    const rows = await h.prisma.emailVerificationCode.findMany({ where: { userId: id } });
    expect(rows[0]?.attempts).toBe(env.VERIFICATION_MAX_ATTEMPTS);
  });

  it('refuses even the correct code after the cap, leaving the user pending', async () => {
    const { id, code } = await register('burned@example.test');
    const wrong = anyCodeOtherThan(code);

    for (let i = 0; i < env.VERIFICATION_MAX_ATTEMPTS; i++) {
      await verify('burned@example.test', wrong);
    }

    const res = await verify('burned@example.test', code);

    expect(res.json<ErrorBody>().error.code).toBe('TOO_MANY_VERIFICATION_ATTEMPTS');
    const persisted = await h.prisma.user.findUnique({ where: { id } });
    expect(persisted?.status).toBe('pending');
  });

  it('answers an unknown email exactly as it answers a wrong code (400)', async () => {
    const { code } = await register('known@example.test');

    const unknown = await verify('nobody@example.test', '123456');
    const wrong = await verify('known@example.test', anyCodeOtherThan(code));

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json<ErrorBody>().error.code).toBe(wrong.json<ErrorBody>().error.code);
    expect(unknown.json<ErrorBody>().error.code).toBe('VERIFICATION_CODE_INVALID');
  });

  it.each(['12345', '1234567', 'abcdef', ''])('rejects a malformed code %j (400)', async (code) => {
    const res = await verify('someone@example.test', code);

    expect(res.statusCode).toBe(400);
  });

  // Capstone: the sub-flow that used to live in the register test, now gated on
  // verification. A verified self-service account authenticates but, holding no
  // roles, is still refused by an authorized endpoint.
  it('register -> login 401 -> verify -> login 200 -> authorized endpoint 403', async () => {
    const { code } = await register('flow@example.test');

    const before = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'flow@example.test', password: PASSWORD },
    });
    expect(before.statusCode).toBe(401);

    expect((await verify('flow@example.test', code)).statusCode).toBe(200);

    const after = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'flow@example.test', password: PASSWORD },
    });
    expect(after.statusCode).toBe(200);

    const { accessToken } = after.json<{ accessToken: string }>();
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(list.statusCode).toBe(403);
  });
});
