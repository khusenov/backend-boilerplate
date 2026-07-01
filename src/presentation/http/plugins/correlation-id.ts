import fp from 'fastify-plugin';
import { fastifyRequestContext, requestContext } from '@fastify/request-context';
import type { ContextData } from '@/application/shared/ports/context-provider';

export const CORRELATION_ID_HEADER = 'x-request-id' as const;

export const correlationIdPlugin = fp(async (app) => {
  await app.register(fastifyRequestContext);

  app.addHook('onRequest', (request, reply, done) => {
    const contextData: ContextData = { correlationId: request.id };
    requestContext.set('contextData', contextData);
    reply.header(CORRELATION_ID_HEADER, request.id);
    done();
  });
});
