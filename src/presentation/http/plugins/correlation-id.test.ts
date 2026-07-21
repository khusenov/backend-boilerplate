import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { requestContext } from '@fastify/request-context';
import { CORRELATION_ID_HEADER, correlationIdPlugin } from './correlation-id';

describe('correlationIdPlugin', () => {
  it('echoes the request id back as the correlation-id response header', async () => {
    const app = fastify({ logger: false });
    await app.register(correlationIdPlugin);
    app.get('/probe', (request, reply) => reply.send({ requestId: request.id }));

    const response = await app.inject({ method: 'GET', url: '/probe' });
    const body = response.json<{ requestId: string }>();

    expect(response.headers[CORRELATION_ID_HEADER]).toBe(body.requestId);
    await app.close();
  });

  it('exposes the request id as the correlationId in the request context', async () => {
    const app = fastify({ logger: false });
    await app.register(correlationIdPlugin);
    app.get('/probe', (request, reply) => {
      const contextData = requestContext.get('contextData');
      return reply.send({ fromContext: contextData?.correlationId, requestId: request.id });
    });

    const response = await app.inject({ method: 'GET', url: '/probe' });
    const body = response.json<{ fromContext: string; requestId: string }>();

    expect(body.fromContext).toBe(body.requestId);
    await app.close();
  });

  it('assigns a distinct correlation id to each request', async () => {
    const app = fastify({ logger: false });
    await app.register(correlationIdPlugin);
    app.get('/probe', (_request, reply) => reply.send({ ok: true }));

    const first = await app.inject({ method: 'GET', url: '/probe' });
    const second = await app.inject({ method: 'GET', url: '/probe' });

    expect(first.headers[CORRELATION_ID_HEADER]).not.toBe(second.headers[CORRELATION_ID_HEADER]);
    await app.close();
  });
});
