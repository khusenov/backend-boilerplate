import { afterEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import fastifyBasicAuth from '@fastify/basic-auth';
import { bullBoardPlugin, createBasicAuthValidator } from './bull-board';

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' " +
  "https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' data: " +
  "https://fonts.gstatic.com; connect-src 'self'";

describe('createBasicAuthValidator', () => {
  it('rejects when the dashboard credentials are not configured', async () => {
    const validate = createBasicAuthValidator('admin', '');
    await expect(validate('admin', 'anything')).rejects.toThrow(/not configured/);
  });

  it('rejects when the provided credentials do not match', async () => {
    const validate = createBasicAuthValidator('admin', 'super-secret-password');
    await expect(validate('admin', 'wrong')).rejects.toThrow(/Invalid dashboard credentials/);
  });

  it('accepts credentials that match exactly', async () => {
    const validate = createBasicAuthValidator('admin', 'super-secret-password');
    await expect(validate('admin', 'super-secret-password')).resolves.toBeUndefined();
  });
});

describe('createBasicAuthValidator wired into @fastify/basic-auth', () => {
  async function buildGuardedApp(username: string, password: string): Promise<FastifyInstance> {
    const app = fastify({ logger: false });
    await app.register(fastifyBasicAuth, {
      validate: createBasicAuthValidator(username, password),
      authenticate: true,
    });
    app.addHook('onRequest', app.basicAuth);
    app.get('/probe', (_request, reply) => reply.send('ok'));
    return app;
  }

  it('passes the request through on valid credentials instead of hanging', async () => {
    const app = await buildGuardedApp('admin', 'super-secret-password');
    const credentials = Buffer.from('admin:super-secret-password').toString('base64');

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Basic ${credentials}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('challenges with 401 on wrong credentials', async () => {
    const app = await buildGuardedApp('admin', 'super-secret-password');
    const credentials = Buffer.from('admin:wrong').toString('base64');

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Basic ${credentials}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('bullBoardPlugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('guards the dashboard with basic auth and stamps a CSP header', async () => {
    app = fastify({ logger: false });
    await app.register(fastifyAwilixPlugin, {
      disposeOnClose: true,
      disposeOnResponse: true,
      strictBooleanEnforced: true,
      injectionMode: 'PROXY',
    });
    diContainer.register({
      dashboardQueue: asValue({ name: 'finflow', metaValues: { version: 'bullmq' } }),
    });
    await app.register(bullBoardPlugin);

    const response = await app.inject({ method: 'GET', url: '/admin/queues' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-security-policy']).toBe(DASHBOARD_CSP);
  });
});
