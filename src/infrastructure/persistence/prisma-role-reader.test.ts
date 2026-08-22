import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaRoleReader } from './prisma-role-reader';
import type { Role as RoleRow } from '@/generated/prisma/client';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

const ROLE_INCLUDE = {
  permissions: { select: { permission: { select: { key: true } } } },
};

type RoleRowWithPermissions = RoleRow & { permissions: { permission: { key: string } }[] };

function makeRoleRow(overrides: Partial<RoleRowWithPermissions> = {}): RoleRowWithPermissions {
  const now = new Date('2026-01-15T10:00:00.000Z');
  return {
    id: 'role-1',
    key: null,
    name: 'Editor',
    description: null,
    isSystem: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    permissions: [{ permission: { key: 'users.read' } }],
    ...overrides,
  };
}

function makeReader() {
  const roleDelegate = {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  };

  const prisma = { role: roleDelegate } as unknown as PrismaTransactionalClient;

  return { reader: new PrismaRoleReader({ prisma }), roleDelegate };
}

describe('PrismaRoleReader', () => {
  let ctx: ReturnType<typeof makeReader>;

  beforeEach(() => {
    ctx = makeReader();
  });

  describe('list', () => {
    it('returns mapped domain items and total', async () => {
      ctx.roleDelegate.findMany.mockResolvedValue([makeRoleRow()]);
      ctx.roleDelegate.count.mockResolvedValue(1);

      const result = await ctx.reader.list({ page: 1, pageSize: 10 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toBe('role-1');
      expect(result.items[0]!.permissions).toEqual(['users.read']);
    });

    it('returns empty items and zero total when no records exist', async () => {
      ctx.roleDelegate.findMany.mockResolvedValue([]);
      ctx.roleDelegate.count.mockResolvedValue(0);

      const result = await ctx.reader.list({ page: 1, pageSize: 10 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('calculates correct skip for page 2', async () => {
      ctx.roleDelegate.findMany.mockResolvedValue([]);
      ctx.roleDelegate.count.mockResolvedValue(0);

      await ctx.reader.list({ page: 2, pageSize: 5 });

      expect(ctx.roleDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('only fetches non-deleted records on both reads', async () => {
      ctx.roleDelegate.findMany.mockResolvedValue([]);
      ctx.roleDelegate.count.mockResolvedValue(0);

      await ctx.reader.list({ page: 1, pageSize: 10 });

      expect(ctx.roleDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
      expect(ctx.roleDelegate.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    });

    it('includes the permission join rows', async () => {
      ctx.roleDelegate.findMany.mockResolvedValue([]);
      ctx.roleDelegate.count.mockResolvedValue(0);

      await ctx.reader.list({ page: 1, pageSize: 10 });

      expect(ctx.roleDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: ROLE_INCLUDE }),
      );
    });
  });

  describe('findById', () => {
    it('returns a mapped Role when found', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(makeRoleRow());

      const result = await ctx.reader.findById('role-1');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Editor');
    });

    it('returns null when not found', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(null);

      expect(await ctx.reader.findById('missing')).toBeNull();
    });

    it('filters soft-deleted rows and includes permissions', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(null);

      await ctx.reader.findById('role-1');

      expect(ctx.roleDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'role-1', deletedAt: null },
        include: ROLE_INCLUDE,
      });
    });
  });

  describe('findByKey', () => {
    it('returns a mapped Role when found', async () => {
      ctx.roleDelegate.findUnique.mockResolvedValue(
        makeRoleRow({ key: 'super-admin', isSystem: true }),
      );

      const result = await ctx.reader.findByKey('super-admin');

      expect(result!.key).toBe('super-admin');
    });

    it('returns null when not found', async () => {
      ctx.roleDelegate.findUnique.mockResolvedValue(null);

      expect(await ctx.reader.findByKey('missing')).toBeNull();
    });

    it('reads the unique key without a deletedAt filter — SyncAuthorization relies on it', async () => {
      ctx.roleDelegate.findUnique.mockResolvedValue(null);

      await ctx.reader.findByKey('super-admin');

      expect(ctx.roleDelegate.findUnique).toHaveBeenCalledWith({
        where: { key: 'super-admin' },
        include: ROLE_INCLUDE,
      });
    });
  });

  describe('findByName', () => {
    it('returns a mapped Role when found', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(makeRoleRow());

      const result = await ctx.reader.findByName('Editor');

      expect(result!.name).toBe('Editor');
    });

    it('returns null when not found', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(null);

      expect(await ctx.reader.findByName('missing')).toBeNull();
    });

    it('filters soft-deleted rows and includes permissions', async () => {
      ctx.roleDelegate.findFirst.mockResolvedValue(null);

      await ctx.reader.findByName('Editor');

      expect(ctx.roleDelegate.findFirst).toHaveBeenCalledWith({
        where: { name: 'Editor', deletedAt: null },
        include: ROLE_INCLUDE,
      });
    });
  });
});
