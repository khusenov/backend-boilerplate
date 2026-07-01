import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { fastifyRequestContext, requestContext } from '@fastify/request-context';
import type { ContextData } from '@/application/shared/ports/context-provider';
import { RequestContextProvider } from './request-context-provider';

async function buildTestApp() {
  const app = Fastify();
  await app.register(fastifyRequestContext);
  return app;
}

describe('RequestContextProvider', () => {
  it('getAll returns the ContextData set in the current request scope', async () => {
    const app = await buildTestApp();
    const provider = new RequestContextProvider();
    const data: ContextData = { correlationId: 'test-id' };

    app.get('/test', () => {
      requestContext.set('contextData', data);
      return provider.getAll();
    });

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.json()).toEqual({ correlationId: 'test-id' });
  });

  it('getAll returns {} when called outside a request context', () => {
    const provider = new RequestContextProvider();
    expect(provider.getAll()).toEqual({});
  });
});
