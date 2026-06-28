import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { requirePermission } from '@/presentation/http/guards/authorize';

export const permissionRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = {
      ...route.schema,
      tags: ['Permissions'],
      security: [{ bearerAuth: [] }],
    };
  });

  app.get('/', { preHandler: requirePermission('roles.read') }, async (request, reply) => {
    const { listPermissions } = request.diScope.cradle;
    return reply.status(200).send(listPermissions.execute());
  });

  done();
};
