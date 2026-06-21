import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

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

export const userRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = {
      ...route.schema,
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
    };
  });

  app.get('/', { schema: { querystring: listUsersQuery } }, async (request, reply) => {
    const { listUsers } = request.diScope.cradle;
    const page = await listUsers.execute(request.query);
    return reply.status(200).send(page);
  });

  app.get('/:id', { schema: { params: getUserParams } }, async (request, reply) => {
    const { getUser } = request.diScope.cradle;
    const user = await getUser.execute({ id: request.params.id });
    return reply.status(200).send(user);
  });

  app.post('/', { schema: { body: createUserBody } }, async (request, reply) => {
    const { createUser } = request.diScope.cradle;
    const user = await createUser.execute(request.body);
    return reply.status(201).send(user);
  });

  app.patch(
    '/:id',
    { schema: { params: editUserParams, body: editUserBody } },
    async (request, reply) => {
      const { editUser } = request.diScope.cradle;
      const user = await editUser.execute({ id: request.params.id, ...request.body });
      return reply.status(200).send(user);
    },
  );

  app.delete('/:id', { schema: { params: deleteUserParams } }, async (request, reply) => {
    const { deleteUser } = request.diScope.cradle;
    await deleteUser.execute({ id: request.params.id });
    return reply.status(204).send();
  });

  done();
};
