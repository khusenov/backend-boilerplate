import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from '../support/harness';
import { seedUser } from '../support/factories';

const REGISTER_URL = '/v1/auth/register';

type RegistrationOverrides = Partial<{
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}>;

function registrationPayload(overrides: RegistrationOverrides = {}) {
  return {
    firstName: 'Ida',
    lastName: 'Potent',
    email: `idem-${randomUUID()}@finflow.test`,
    password: 'password123',
    ...overrides,
  };
}

function errorCodeOf(res: { json: <T>() => T }): string {
  return res.json<{ error: { code: string } }>().error.code;
}

describe('/v1/auth/register idempotency (integration)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  it('replays the original response for a repeated key without executing twice', async () => {
    const key = randomUUID();
    const payload = registrationPayload();

    const first = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await h.prisma.user.count()).toBe(1);

    const replay = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload,
    });

    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toBe(first.body);
    expect(await h.prisma.user.count()).toBe(1);
  });

  it('does not deduplicate when no Idempotency-Key is sent', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: registrationPayload(),
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const second = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      payload: registrationPayload(),
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();

    expect(await h.prisma.user.count()).toBe(2);
  });

  it('rejects a concurrent in-flight request for the same key with 409', async () => {
    const key = randomUUID();
    await h.app.diContainer.cradle.idempotencyStore.claim(key);

    const res = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload: registrationPayload(),
    });

    expect(res.statusCode).toBe(409);
    expect(errorCodeOf(res)).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(await h.prisma.user.count()).toBe(0);

    await h.app.diContainer.cradle.idempotencyStore.release(key);
  });

  it('rejects the same key reused with different parameters with 400', async () => {
    const key = randomUUID();

    const first = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload: registrationPayload({ email: `first-${randomUUID()}@finflow.test` }),
    });
    expect(first.statusCode).toBe(201);

    const mismatch = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload: registrationPayload({ email: `second-${randomUUID()}@finflow.test` }),
    });

    expect(mismatch.statusCode).toBe(400);
    expect(errorCodeOf(mismatch)).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(await h.prisma.user.count()).toBe(1);
  });

  it('rejects a blank Idempotency-Key with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': '   ' },
      payload: registrationPayload(),
    });

    expect(res.statusCode).toBe(400);
    expect(errorCodeOf(res)).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await h.prisma.user.count()).toBe(0);
  });

  it('replays a cached client error (4xx) for the same key', async () => {
    const existing = await seedUser(h.app, { email: `dupe-${randomUUID()}@finflow.test` });
    const key = randomUUID();
    const payload = registrationPayload({ email: existing.email });

    const first = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(409);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const replay = await h.app.inject({
      method: 'POST',
      url: REGISTER_URL,
      headers: { 'idempotency-key': key },
      payload,
    });

    expect(replay.statusCode).toBe(409);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toBe(first.body);
  });
});
