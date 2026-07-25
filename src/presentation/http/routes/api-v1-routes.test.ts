import Fastify from 'fastify';
import type { FastifyPluginCallback } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { apiV1Routes } from '@/presentation/http/routes/api-v1-routes';

vi.mock('@/presentation/http/routes/auth-routes', () => ({
  authRoutes: ((app, _opts, done) => {
    app.get('/login', () => 'auth');
    done();
  }) satisfies FastifyPluginCallback,
}));
vi.mock('@/presentation/http/routes/user-routes', () => ({
  userRoutes: ((app, _opts, done) => {
    app.get('/', () => 'users');
    done();
  }) satisfies FastifyPluginCallback,
}));
vi.mock('@/presentation/http/routes/role-routes', () => ({
  roleRoutes: ((app, _opts, done) => {
    app.get('/', () => 'roles');
    done();
  }) satisfies FastifyPluginCallback,
}));
vi.mock('@/presentation/http/routes/permission-routes', () => ({
  permissionRoutes: ((app, _opts, done) => {
    app.get('/', () => 'permissions');
    done();
  }) satisfies FastifyPluginCallback,
}));

describe('apiV1Routes', () => {
  it('mounts each resource plugin under its own /v1 sub-prefix', async () => {
    const app = Fastify();
    await app.register(apiV1Routes, { prefix: '/v1' });
    await app.ready();

    const expectedBody: Record<string, string> = {
      '/v1/auth/login': 'auth',
      '/v1/users': 'users',
      '/v1/roles': 'roles',
      '/v1/permissions': 'permissions',
    };
    for (const [url, body] of Object.entries(expectedBody)) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(body);
    }

    const unversioned = await app.inject({ method: 'GET', url: '/users' });
    expect(unversioned.statusCode).toBe(404);

    await app.close();
  });
});
