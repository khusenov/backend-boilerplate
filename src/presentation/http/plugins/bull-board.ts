import { createHash, timingSafeEqual } from 'node:crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { diContainer } from '@fastify/awilix';
import fastifyBasicAuth from '@fastify/basic-auth';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config/env';

const BULL_BOARD_REALM = 'Finflow Queues';

const DASHBOARD_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
].join('; ');

function constantTimeEquals(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function createBasicAuthValidator(username: string, password: string) {
  return function validate(providedUsername: string, providedPassword: string): Promise<void> {
    if (username.length === 0 || password.length === 0) {
      return Promise.reject(new Error('Dashboard credentials are not configured'));
    }
    const usernameMatches = constantTimeEquals(providedUsername, username);
    const passwordMatches = constantTimeEquals(providedPassword, password);
    if (!usernameMatches || !passwordMatches) {
      return Promise.reject(new Error('Invalid dashboard credentials'));
    }
    return Promise.resolve();
  };
}

export async function bullBoardPlugin(app: FastifyInstance): Promise<void> {
  const basePath = env.BULL_BOARD_PATH;

  await app.register(fastifyBasicAuth, {
    validate: createBasicAuthValidator(env.BULL_BOARD_USERNAME, env.BULL_BOARD_PASSWORD),
    authenticate: { realm: BULL_BOARD_REALM },
  });

  app.addHook('onRequest', app.basicAuth);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', DASHBOARD_CONTENT_SECURITY_POLICY);
    return payload;
  });

  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: [
      new BullMQAdapter(diContainer.cradle.dashboardQueue, {
        readOnlyMode: env.BULL_BOARD_READONLY,
      }),
    ],
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), { prefix: basePath });
}
