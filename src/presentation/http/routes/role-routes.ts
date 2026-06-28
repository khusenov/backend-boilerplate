import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { requirePermission } from '@/presentation/http/guards/authorize';

const listRolesQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

const roleParams = z.object({
  id: z.uuid(),
});

const createRoleBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
  permissions: z.array(z.string()).optional(),
});

const editRoleBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(255).nullable().optional(),
  permissions: z.array(z.string()).optional(),
});

export const roleRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = {
      ...route.schema,
      tags: ['Roles'],
      security: [{ bearerAuth: [] }],
    };
  });

  app.get(
    '/',
    { preHandler: requirePermission('roles.read'), schema: { querystring: listRolesQuery } },
    async (request, reply) => {
      const { listRoles } = request.diScope.cradle;
      const page = await listRoles.execute(request.query);
      return reply.status(200).send(page);
    },
  );

  app.get(
    '/:id',
    { preHandler: requirePermission('roles.read'), schema: { params: roleParams } },
    async (request, reply) => {
      const { getRole } = request.diScope.cradle;
      const role = await getRole.execute({ id: request.params.id });
      return reply.status(200).send(role);
    },
  );

  app.post(
    '/',
    { preHandler: requirePermission('roles.create'), schema: { body: createRoleBody } },
    async (request, reply) => {
      const { createRole } = request.diScope.cradle;
      const role = await createRole.execute(request.body);
      return reply.status(201).send(role);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('roles.update'),
      schema: { params: roleParams, body: editRoleBody },
    },
    async (request, reply) => {
      const { editRole } = request.diScope.cradle;
      const role = await editRole.execute({ id: request.params.id, ...request.body });
      return reply.status(200).send(role);
    },
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission('roles.delete'), schema: { params: roleParams } },
    async (request, reply) => {
      const { deleteRole } = request.diScope.cradle;
      await deleteRole.execute({ id: request.params.id });
      return reply.status(204).send();
    },
  );

  done();
};
