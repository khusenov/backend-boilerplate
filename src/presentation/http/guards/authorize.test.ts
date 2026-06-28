import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requirePermission, requireSelfOrPermission } from './authorize';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors';
import type { AccessTokenPayload } from '@/application/shared/ports/access-token-service';

function request(user?: Partial<AccessTokenPayload>, params: unknown = {}): FastifyRequest {
  const fullUser = user
    ? { sub: 'user-1', email: 'u@x.com', systemRoleKeys: [], permissions: [], ...user }
    : undefined;
  return { user: fullUser, params } as unknown as FastifyRequest;
}

describe('requirePermission', () => {
  it('throws UnauthorizedError when there is no authenticated user', async () => {
    await expect(requirePermission('users.read')(request())).rejects.toThrow(UnauthorizedError);
  });

  it('passes when the user holds the permission', async () => {
    const guard = requirePermission('users.read');
    await expect(guard(request({ permissions: ['users.read'] }))).resolves.toBeUndefined();
  });

  it('throws ForbiddenError when the permission is missing', async () => {
    const guard = requirePermission('users.delete');
    await expect(guard(request({ permissions: ['users.read'] }))).rejects.toThrow(ForbiddenError);
  });

  it('lets a superadmin bypass the permission check', async () => {
    const guard = requirePermission('users.delete');
    await expect(
      guard(request({ systemRoleKeys: ['super-admin'], permissions: [] })),
    ).resolves.toBeUndefined();
  });

  it('returns a clean 403 (not a crash) for a legacy payload with no permissions', async () => {
    // Simulates a pre-rollout token degraded to empty arrays by verify() (W13):
    // the guard must reject, never throw on `undefined.includes(...)`.
    const guard = requirePermission('users.read');
    await expect(guard(request({ permissions: [] }))).rejects.toThrow(ForbiddenError);
  });
});

describe('requireSelfOrPermission', () => {
  const targetId = (r: FastifyRequest) => (r.params as { id: string }).id;

  it('throws UnauthorizedError when there is no authenticated user', async () => {
    const guard = requireSelfOrPermission(targetId, 'users.update');
    await expect(guard(request(undefined, { id: 'user-1' }))).rejects.toThrow(UnauthorizedError);
  });

  it('passes when acting on your own record without the permission', async () => {
    const guard = requireSelfOrPermission(targetId, 'users.update');
    await expect(
      guard(request({ sub: 'user-1', permissions: [] }, { id: 'user-1' })),
    ).resolves.toBeUndefined();
  });

  it('passes for another record when you hold the permission', async () => {
    const guard = requireSelfOrPermission(targetId, 'users.update');
    await expect(
      guard(request({ sub: 'user-1', permissions: ['users.update'] }, { id: 'user-2' })),
    ).resolves.toBeUndefined();
  });

  it('throws ForbiddenError for another record without the permission', async () => {
    const guard = requireSelfOrPermission(targetId, 'users.update');
    await expect(
      guard(request({ sub: 'user-1', permissions: [] }, { id: 'user-2' })),
    ).rejects.toThrow(ForbiddenError);
  });

  it('lets a superadmin bypass even for another record', async () => {
    const guard = requireSelfOrPermission(targetId, 'users.update');
    await expect(
      guard(request({ sub: 'user-1', systemRoleKeys: ['super-admin'] }, { id: 'user-2' })),
    ).resolves.toBeUndefined();
  });
});
