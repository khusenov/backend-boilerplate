import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IdempotentResponse } from '@/application/shared/ports/idempotency-store';
import { ConflictError, ValidationError } from '@/shared/errors';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
export const REPLAY_CONTENT_TYPE = 'application/json; charset=utf-8';

const RETRYABLE_STATUS_THRESHOLD = 500;
const REPLAYED_FLAG = 'true';
const FINGERPRINT_SEPARATOR = '\n';

declare module 'fastify' {
  interface FastifyContextConfig {
    idempotency?: boolean;
  }
  interface FastifyRequest {
    idempotency?: { key: string; fingerprint: string };
  }
}

export function fingerprintRequest(request: FastifyRequest): string {
  const serializedBody = request.body === undefined ? '' : JSON.stringify(request.body);
  return createHash('sha256')
    .update(request.method)
    .update(FINGERPRINT_SEPARATOR)
    .update(request.url)
    .update(FINGERPRINT_SEPARATOR)
    .update(serializedBody)
    .digest('hex');
}

function isIdempotentRoute(request: FastifyRequest): boolean {
  return request.routeOptions.config.idempotency === true;
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof header !== 'string') {
    return undefined;
  }
  if (header.trim() === '') {
    throw new ValidationError('The Idempotency-Key header must not be blank.', {
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
  }
  return header;
}

function isStorableResponse(statusCode: number, payload: unknown): payload is string {
  return statusCode < RETRYABLE_STATUS_THRESHOLD && typeof payload === 'string';
}

function replay(reply: FastifyReply, response: IdempotentResponse): FastifyReply {
  return reply
    .header(IDEMPOTENT_REPLAYED_HEADER, REPLAYED_FLAG)
    .header('content-type', REPLAY_CONTENT_TYPE)
    .status(response.status)
    .send(response.body);
}

export const idempotencyPlugin = fp((app) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isIdempotentRoute(request)) {
      return;
    }

    const key = readIdempotencyKey(request);
    if (key === undefined) {
      return;
    }

    const fingerprint = fingerprintRequest(request);
    const claim = await request.diScope.cradle.idempotencyStore.claim(key);

    if (claim.outcome === 'in_flight') {
      throw new ConflictError('A request with this Idempotency-Key is already being processed.', {
        code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      });
    }

    if (claim.outcome === 'replayed') {
      if (claim.response.fingerprint !== fingerprint) {
        throw new ValidationError(
          'This Idempotency-Key was already used with different request parameters.',
          { code: 'IDEMPOTENCY_KEY_MISMATCH' },
        );
      }
      return replay(reply, claim.response);
    }

    request.idempotency = { key, fingerprint };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const pending = request.idempotency;
    if (pending === undefined) {
      return payload;
    }

    const store = request.diScope.cradle.idempotencyStore;
    if (!isStorableResponse(reply.statusCode, payload)) {
      await store.release(pending.key);
      return payload;
    }

    await store.complete(pending.key, {
      status: reply.statusCode,
      body: payload,
      fingerprint: pending.fingerprint,
    });
    return payload;
  });
});
