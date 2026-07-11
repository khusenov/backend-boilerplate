import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '@/presentation/http/cookies';
import { env } from '@/config/env';
import { userResponse } from '../schemas/user-response-schema';
import { loginResponse, refreshResponse } from '../schemas/auth-response-schema';
import { errorResponse } from '../schemas/error-schema';

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const registerBody = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(128),
});

const refreshBody = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .nullish()
  .transform((value) => value ?? {});

export const authRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRoute', (route) => {
    route.schema = { ...route.schema, tags: ['Auth'] };
  });

  app.post(
    '/register',
    {
      config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: { body: registerBody, response: { 201: userResponse, 409: errorResponse } },
    },
    async (request, reply) => {
      const { createUser } = request.diScope.cradle;
      const user = await createUser.execute(request.body);
      return reply.status(201).send(user);
    },
  );

  app.post(
    '/login',
    {
      config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW } },
      schema: { body: loginBody, response: { 200: loginResponse, 401: errorResponse } },
    },
    async (request, reply) => {
      const { login, env } = request.diScope.cradle;
      const result = await login.execute(request.body);

      const body = {
        user: result.user,
        accessToken: result.tokens.accessToken,
      };

      setRefreshCookie(reply, result.tokens.refreshToken, env);

      return reply.status(200).send(body);
    },
  );

  app.post(
    '/refresh',
    { schema: { body: refreshBody, response: { 200: refreshResponse, 401: errorResponse } } },
    async (request, reply) => {
      const { refreshSession, env } = request.diScope.cradle;
      const refreshToken = readRefreshCookie(request, env) ?? request.body?.refreshToken;

      if (!refreshToken) {
        return reply.unauthorized('Missing refresh token'); // @fastify/sensible
      }

      const tokens = await refreshSession.execute({ refreshToken });

      const body = {
        accessToken: tokens.accessToken,
      };

      setRefreshCookie(reply, tokens.refreshToken, env);
      return reply.status(200).send(body);
    },
  );

  app.post('/logout', { schema: { body: refreshBody } }, async (request, reply) => {
    const { logout, env } = request.diScope.cradle;
    const refreshToken = readRefreshCookie(request, env) ?? request.body?.refreshToken;

    await logout.execute({ refreshToken });
    clearRefreshCookie(reply, env);

    return reply.status(204).send();
  });

  app.get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: {
        security: [{ bearerAuth: [] }],
        response: { 200: userResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { getUser } = request.diScope.cradle;
      const user = await getUser.execute({ id: request.user!.sub });
      return reply.status(200).send(user);
    },
  );

  done();
};
