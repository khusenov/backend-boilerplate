import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { requirePermission, requireSelfOrPermission } from '@/presentation/http/guards/authorize';

const listUsersQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

const getUserParams = z.object({
  id: z.uuid(),
});

const createUserBody = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(128),
});

const editUserParams = getUserParams;

const editUserBody = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
});

const deleteUserParams = getUserParams;

const assignRoleParams = getUserParams;

const assignRoleBody = z.object({
  roleId: z.uuid(),
});

const revokeRoleParams = z.object({
  id: z.uuid(),
  roleId: z.uuid(),
});

export const userRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = {
      ...route.schema,
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
    };
  });

  app.get(
    '/',
    {
      preHandler: requirePermission('users.read'),
      schema: { querystring: listUsersQuery },
    },
    async (request, reply) => {
      const { listUsers } = request.diScope.cradle;
      const page = await listUsers.execute(request.query);
      return reply.status(200).send(page);
    },
  );

  app.get(
    '/:id',
    {
      preHandler: requireSelfOrPermission((r) => (r.params as { id: string }).id, 'users.read'),
      schema: { params: getUserParams },
    },
    async (request, reply) => {
      const { getUser } = request.diScope.cradle;
      const user = await getUser.execute({ id: request.params.id });
      return reply.status(200).send(user);
    },
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('users.create'),
      schema: { body: createUserBody },
    },
    async (request, reply) => {
      const { createUser } = request.diScope.cradle;
      const user = await createUser.execute(request.body);
      return reply.status(201).send(user);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: requireSelfOrPermission((r) => (r.params as { id: string }).id, 'users.update'),
      schema: { params: editUserParams, body: editUserBody },
    },
    async (request, reply) => {
      const { editUser } = request.diScope.cradle;
      const user = await editUser.execute({ id: request.params.id, ...request.body });
      return reply.status(200).send(user);
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: requirePermission('users.delete'),
      schema: { params: deleteUserParams },
    },
    async (request, reply) => {
      const { deleteUser } = request.diScope.cradle;
      await deleteUser.execute({ id: request.params.id });
      return reply.status(204).send();
    },
  );

  app.post(
    '/:id/roles',
    {
      preHandler: requirePermission('roles.assign'),
      schema: { params: assignRoleParams, body: assignRoleBody },
    },
    async (request, reply) => {
      const { assignRole } = request.diScope.cradle;
      await assignRole.execute({ userId: request.params.id, roleId: request.body.roleId });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/:id/roles/:roleId',
    {
      preHandler: requirePermission('roles.assign'),
      schema: { params: revokeRoleParams },
    },
    async (request, reply) => {
      const { revokeRole } = request.diScope.cradle;
      await revokeRole.execute({ userId: request.params.id, roleId: request.params.roleId });
      return reply.status(204).send();
    },
  );

  done();
};
