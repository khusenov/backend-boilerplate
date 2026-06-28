import type { FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors';
import {
  SUPERADMIN_ROLE_KEY,
  type PermissionKey,
} from '@/domain/authorization/permission-catalogue';

function assertAuthenticated(request: FastifyRequest) {
  if (!request.user) {
    throw new UnauthorizedError('Missing access token', { code: 'MISSING_ACCESS_TOKEN' });
  }
  return request.user;
}

function isSuperadmin(user: { systemRoleKeys: string[] }): boolean {
  return user.systemRoleKeys.includes(SUPERADMIN_ROLE_KEY);
}

export function requirePermission(permission: PermissionKey) {
  // async (no await): the preHandler must return a thenable so Fastify advances
  // on resolution and routes a throw to the error handler — a sync void hook
  // without `done` would hang the request.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (request: FastifyRequest): Promise<void> => {
    const user = assertAuthenticated(request);
    if (isSuperadmin(user)) return;
    if (!user.permissions.includes(permission)) {
      throw new ForbiddenError('Insufficient permissions', {
        code: 'FORBIDDEN',
        details: { required: permission },
      });
    }
  };
}

export function requireSelfOrPermission(
  getTargetUserId: (request: FastifyRequest) => string,
  permission: PermissionKey,
) {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (request: FastifyRequest): Promise<void> => {
    const user = assertAuthenticated(request);
    if (isSuperadmin(user)) return;
    if (user.sub === getTargetUserId(request)) return;
    if (!user.permissions.includes(permission)) {
      throw new ForbiddenError('Insufficient permissions', {
        code: 'FORBIDDEN',
        details: { required: permission },
      });
    }
  };
}
