import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { authRoutes } from '@/presentation/http/routes/auth-routes';
import { permissionRoutes } from '@/presentation/http/routes/permission-routes';
import { roleRoutes } from '@/presentation/http/routes/role-routes';
import { userRoutes } from '@/presentation/http/routes/user-routes';

export const apiV1Routes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.register(authRoutes, { prefix: '/auth' });
  app.register(userRoutes, { prefix: '/users' });
  app.register(roleRoutes, { prefix: '/roles' });
  app.register(permissionRoutes, { prefix: '/permissions' });
  done();
};
