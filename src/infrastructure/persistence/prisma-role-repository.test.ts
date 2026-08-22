import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaRoleRepository } from './prisma-role-repository';
import { toDomain } from './prisma-role-mapper';
import { Role } from '@/domain/authorization/role-entity';
import { ConflictError, ErrorKind } from '@/shared/errors';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import type { Role as RoleRow } from '@/generated/prisma/client';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

const CREATED_AT = new Date('2026-01-15T10:00:00.000Z');

type RoleRowWithPermissions = RoleRow & { permissions: { permission: { key: string } }[] };
type MutableRoleFields = Omit<RoleRow, 'id' | 'createdAt'>;

function makeRoleRow(overrides: Partial<RoleRowWithPermissions> = {}): RoleRowWithPermissions {
  return {
    id: 'role-1',
    key: null,
    name: 'Editor',
    description: null,
    isSystem: false,
    version: 4,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    permissions: [],
    ...overrides,
  };
}

function makePrismaError(code: string): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError('prisma error', { code, clientVersion: '7.0.0' });
}

function makeRepo() {
  const roleDelegate = {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn<(args: { data: RoleRow }) => Promise<unknown>>().mockResolvedValue(undefined),
    updateMany: vi
      .fn<
        (args: {
          where: { id: string; version: number };
          data: MutableRoleFields;
        }) => Promise<{ count: number }>
      >()
      .mockResolvedValue({ count: 1 }),
  };

  const permissionDelegate = {
    findMany: vi
      .fn<(args: { where: { key: { in: string[] } } }) => Promise<{ id: string }[]>>()
      .mockResolvedValue([]),
  };

  const rolePermissionDelegate = {
    findMany: vi
      .fn<(args: { where: { roleId: string } }) => Promise<{ permissionId: string }[]>>()
      .mockResolvedValue([]),
    createMany: vi
      .fn<(args: { data: { roleId: string; permissionId: string }[] }) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    deleteMany: vi
      .fn<
        (args: { where: { roleId: string; permissionId: { in: string[] } } }) => Promise<unknown>
      >()
      .mockResolvedValue(undefined),
  };

  const prisma = {
    role: roleDelegate,
    permission: permissionDelegate,
    rolePermission: rolePermissionDelegate,
  } as unknown as PrismaTransactionalClient;

  return {
    repo: new PrismaRoleRepository({ prisma }),
    roleDelegate,
    permissionDelegate,
    rolePermissionDelegate,
  };
}

describe('PrismaRoleRepository', () => {
  let ctx: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    ctx = makeRepo();
  });

  describe('the version guard', () => {
    it('inserts at version 1 when the aggregate has never been persisted', async () => {
      await ctx.repo.save(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));

      expect(ctx.roleDelegate.create).toHaveBeenCalledOnce();
      expect(ctx.roleDelegate.create.mock.calls[0]![0].data.version).toBe(1);
      expect(ctx.roleDelegate.updateMany).not.toHaveBeenCalled();
    });

    it('writes immutable columns (id, createdAt) on insert', async () => {
      await ctx.repo.save(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));

      const { data } = ctx.roleDelegate.create.mock.calls[0]![0];
      expect(data).toHaveProperty('id', 'role-1');
      expect(data).toHaveProperty('createdAt', CREATED_AT);
    });

    it('guards the update on the loaded version and writes the next one', async () => {
      await ctx.repo.save(toDomain(makeRoleRow({ version: 4 })));

      expect(ctx.roleDelegate.create).not.toHaveBeenCalled();
      expect(ctx.roleDelegate.updateMany).toHaveBeenCalledOnce();
      const [args] = ctx.roleDelegate.updateMany.mock.calls[0]!;
      expect(args.where).toEqual({ id: 'role-1', version: 4 });
      expect(args.data.version).toBe(5);
    });

    it('never writes id or createdAt on update', async () => {
      await ctx.repo.save(toDomain(makeRoleRow({ version: 4 })));

      const [args] = ctx.roleDelegate.updateMany.mock.calls[0]!;
      expect(args.data).not.toHaveProperty('id');
      expect(args.data).not.toHaveProperty('createdAt');
    });

    it('throws StaleAggregateError when no row matched the expected version', async () => {
      ctx.roleDelegate.updateMany.mockResolvedValue({ count: 0 });

      await expect(ctx.repo.save(toDomain(makeRoleRow({ version: 4 })))).rejects.toThrow(
        StaleAggregateError,
      );
    });

    it('reports a conflict rather than an internal error on a stale write', async () => {
      ctx.roleDelegate.updateMany.mockResolvedValue({ count: 0 });

      await expect(ctx.repo.save(toDomain(makeRoleRow({ version: 4 })))).rejects.toMatchObject({
        kind: ErrorKind.Conflict,
        code: 'STALE_AGGREGATE',
      });
    });

    it('abandons the permission diff when the version guard failed', async () => {
      ctx.roleDelegate.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ctx.repo.save(toDomain(makeRoleRow({ version: 4, permissions: [] }))),
      ).rejects.toThrow(StaleAggregateError);

      expect(ctx.rolePermissionDelegate.findMany).not.toHaveBeenCalled();
      expect(ctx.rolePermissionDelegate.createMany).not.toHaveBeenCalled();
      expect(ctx.rolePermissionDelegate.deleteMany).not.toHaveBeenCalled();
    });

    it('reports a duplicate insert as a unique violation, not a stale aggregate', async () => {
      ctx.roleDelegate.create.mockRejectedValue(makePrismaError('P2002'));

      await expect(
        ctx.repo.save(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT)),
      ).rejects.toMatchObject({ kind: ErrorKind.Conflict, code: 'UNIQUE_VIOLATION' });
    });

    it('writes no permission rows when the insert was rejected', async () => {
      ctx.roleDelegate.create.mockRejectedValue(makePrismaError('P2002'));

      await expect(
        ctx.repo.save(
          Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] }, CREATED_AT),
        ),
      ).rejects.toThrow(ConflictError);

      expect(ctx.rolePermissionDelegate.createMany).not.toHaveBeenCalled();
    });

    it('leaves the in-memory aggregate untouched — the row is the source of truth', async () => {
      const role = toDomain(makeRoleRow({ version: 4 }));

      await ctx.repo.save(role);

      expect(role.version).toBe(4);
    });
  });

  describe('the permission diff', () => {
    it('adds only the missing permissions and removes only the extra ones', async () => {
      ctx.permissionDelegate.findMany.mockResolvedValue([{ id: 'perm-keep' }, { id: 'perm-add' }]);
      ctx.rolePermissionDelegate.findMany.mockResolvedValue([
        { permissionId: 'perm-keep' },
        { permissionId: 'perm-drop' },
      ]);

      await ctx.repo.save(
        toDomain(
          makeRoleRow({
            version: 4,
            permissions: [
              { permission: { key: 'users.read' } },
              { permission: { key: 'roles.read' } },
            ],
          }),
        ),
      );

      expect(ctx.rolePermissionDelegate.deleteMany).toHaveBeenCalledWith({
        where: { roleId: 'role-1', permissionId: { in: ['perm-drop'] } },
      });
      expect(ctx.rolePermissionDelegate.createMany).toHaveBeenCalledWith({
        data: [{ roleId: 'role-1', permissionId: 'perm-add' }],
      });
    });

    it('writes nothing when the desired and current sets already match', async () => {
      ctx.permissionDelegate.findMany.mockResolvedValue([{ id: 'perm-1' }]);
      ctx.rolePermissionDelegate.findMany.mockResolvedValue([{ permissionId: 'perm-1' }]);

      await ctx.repo.save(
        toDomain(makeRoleRow({ version: 4, permissions: [{ permission: { key: 'users.read' } }] })),
      );

      expect(ctx.rolePermissionDelegate.createMany).not.toHaveBeenCalled();
      expect(ctx.rolePermissionDelegate.deleteMany).not.toHaveBeenCalled();
    });

    it('skips the permission lookup for an empty set but still reads the current rows', async () => {
      await ctx.repo.save(toDomain(makeRoleRow({ version: 4, permissions: [] })));

      expect(ctx.permissionDelegate.findMany).not.toHaveBeenCalled();
      expect(ctx.rolePermissionDelegate.findMany).toHaveBeenCalledWith({
        where: { roleId: 'role-1' },
        select: { permissionId: true },
      });
    });

    it('silently skips keys with no matching permissions row', async () => {
      ctx.permissionDelegate.findMany.mockResolvedValue([{ id: 'perm-known' }]);

      await ctx.repo.save(
        toDomain(
          makeRoleRow({
            version: 4,
            permissions: [
              { permission: { key: 'users.read' } },
              { permission: { key: 'ghost.key' } },
            ],
          }),
        ),
      );

      expect(ctx.rolePermissionDelegate.createMany).toHaveBeenCalledWith({
        data: [{ roleId: 'role-1', permissionId: 'perm-known' }],
      });
    });

    it('translates a Prisma failure during the diff into a mapped error', async () => {
      ctx.rolePermissionDelegate.findMany.mockRejectedValue(makePrismaError('P2002'));

      await expect(ctx.repo.save(toDomain(makeRoleRow({ version: 4 })))).rejects.toThrow(
        ConflictError,
      );
    });
  });
});
