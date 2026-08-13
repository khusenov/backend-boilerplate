import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { toRequestActor } from '@/presentation/http/identity/actor-from-token-payload';
import { errorResponse } from '../schemas/error-schema';
import { paginatedRoles, roleResponse } from '../schemas/role-response-schema';

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
    {
      schema: { querystring: listRolesQuery, response: { 200: paginatedRoles } },
    },
    async (request, reply) => {
      const { listRoles } = request.diScope.cradle;
      const page = await listRoles.execute(request.query, toRequestActor(request.user));
      return reply.status(200).send(page);
    },
  );

  app.get(
    '/:id',
    {
      schema: { params: roleParams, response: { 200: roleResponse, 404: errorResponse } },
    },
    async (request, reply) => {
      const { getRole } = request.diScope.cradle;
      const role = await getRole.execute({ id: request.params.id }, toRequestActor(request.user));
      return reply.status(200).send(role);
    },
  );

  app.post(
    '/',
    {
      schema: { body: createRoleBody, response: { 201: roleResponse, 409: errorResponse } },
    },
    async (request, reply) => {
      const { createRole } = request.diScope.cradle;
      const role = await createRole.execute(request.body, toRequestActor(request.user));
      return reply.status(201).send(role);
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        params: roleParams,
        body: editRoleBody,
        response: { 200: roleResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { editRole } = request.diScope.cradle;
      const role = await editRole.execute(
        { ...request.body, id: request.params.id },
        toRequestActor(request.user),
      );
      return reply.status(200).send(role);
    },
  );

  app.delete('/:id', { schema: { params: roleParams } }, async (request, reply) => {
    const { deleteRole } = request.diScope.cradle;
    await deleteRole.execute({ id: request.params.id }, toRequestActor(request.user));
    return reply.status(204).send();
  });

  done();
};
