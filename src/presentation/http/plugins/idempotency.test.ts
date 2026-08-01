import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  IdempotencyClaim,
  IdempotencyStore,
  IdempotentResponse,
} from '@/application/shared/ports/idempotency-store';
import { registerErrorHandler } from '@/presentation/http/error-handler';
import { ConflictError } from '@/shared/errors';
import { IDEMPOTENT_REPLAYED_HEADER, fingerprintRequest, idempotencyPlugin } from './idempotency';

class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { state: 'in_flight' } | { state: 'completed'; response: IdempotentResponse }
  >();

  claim(key: string): Promise<IdempotencyClaim> {
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, { state: 'in_flight' });
      return Promise.resolve({ outcome: 'claimed' });
    }
    if (existing.state === 'in_flight') {
      return Promise.resolve({ outcome: 'in_flight' });
    }
    return Promise.resolve({ outcome: 'replayed', response: existing.response });
  }

  complete(key: string, response: IdempotentResponse): Promise<void> {
    this.records.set(key, { state: 'completed', response });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}

async function buildTestApp(
  store: IdempotencyStore,
  handler: () => unknown,
): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });
  diContainer.register({ idempotencyStore: asValue(store) });
  registerErrorHandler(app);
  await app.register(idempotencyPlugin);
  app.post('/things', { config: { idempotency: true } }, () => handler());
  app.post('/free', () => handler());
  return app;
}

describe('idempotencyPlugin', () => {
  const KEY = { 'idempotency-key': 'k-123' };
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs the handler once and replays the stored response for a retry', async () => {
    const handler = vi.fn(() => ({ id: 1 }));
    app = await buildTestApp(new InMemoryIdempotencyStore(), handler);

    const first = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });
    const second = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
  });

  it('replays a deterministic 4xx so the same input yields the same error', async () => {
    const handler = vi.fn(() => {
      throw new ConflictError('User already exists', { code: 'USER_EXISTS' });
    });
    app = await buildTestApp(new InMemoryIdempotencyStore(), handler);

    const first = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });
    const second = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.statusCode).toBe(409);
    expect(second.statusCode).toBe(409);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
  });

  it('passes through and is not idempotent when no key is sent', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    app = await buildTestApp(new InMemoryIdempotencyStore(), handler);

    const first = await app.inject({ method: 'POST', url: '/things', payload: {} });
    const second = await app.inject({ method: 'POST', url: '/things', payload: {} });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects a present-but-blank Idempotency-Key with 400', async () => {
    app = await buildTestApp(new InMemoryIdempotencyStore(), () => ({ ok: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'idempotency-key': '   ' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('rejects the same key with a different body as 400 mismatch', async () => {
    app = await buildTestApp(new InMemoryIdempotencyStore(), () => ({ ok: true }));
    await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: { a: 1 } });
    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: KEY,
      payload: { a: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_KEY_MISMATCH',
    );
  });

  it('returns 409 while the first request is still in flight', async () => {
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    app = await buildTestApp(new InMemoryIdempotencyStore(), async () => {
      markEntered();
      await gate;
      return { ok: true };
    });

    const inflight = app
      .inject({ method: 'POST', url: '/things', headers: KEY, payload: {} })
      .then((response) => response);
    await entered;
    const collision = await app.inject({
      method: 'POST',
      url: '/things',
      headers: KEY,
      payload: {},
    });
    release();
    await inflight;

    expect(collision.statusCode).toBe(409);
    expect(collision.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_KEY_IN_PROGRESS',
    );
  });

  it('releases the claim on a 5xx so the request stays retryable', async () => {
    const handler = vi
      .fn<() => unknown>()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockImplementationOnce(() => ({ ok: true }));
    app = await buildTestApp(new InMemoryIdempotencyStore(), handler);

    const failed = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });
    const retried = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });

    expect(failed.statusCode).toBe(500);
    expect(retried.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('releases the claim for a non-string body instead of caching it', async () => {
    const handler = vi.fn(() => Buffer.from('binary'));
    app = await buildTestApp(new InMemoryIdempotencyStore(), handler);

    await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });
    const retried = await app.inject({ method: 'POST', url: '/things', headers: KEY, payload: {} });

    expect(retried.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('ignores routes that do not opt in', async () => {
    const store = new InMemoryIdempotencyStore();
    const claim = vi.spyOn(store, 'claim');
    app = await buildTestApp(store, () => ({ ok: true }));
    const response = await app.inject({ method: 'POST', url: '/free', headers: KEY, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(claim).not.toHaveBeenCalled();
  });

  it('produces a stable fingerprint sensitive to the presence and content of the body', () => {
    type Req = Parameters<typeof fingerprintRequest>[0];
    const withBody = { method: 'POST', url: '/things', body: { a: 1 } } as unknown as Req;
    const sameBody = { method: 'POST', url: '/things', body: { a: 1 } } as unknown as Req;
    const otherBody = { method: 'POST', url: '/things', body: { a: 2 } } as unknown as Req;
    const noBody = { method: 'POST', url: '/things', body: undefined } as unknown as Req;

    expect(fingerprintRequest(withBody)).toBe(fingerprintRequest(sameBody));
    expect(fingerprintRequest(withBody)).not.toBe(fingerprintRequest(otherBody));
    expect(fingerprintRequest(withBody)).not.toBe(fingerprintRequest(noBody));
  });
});
