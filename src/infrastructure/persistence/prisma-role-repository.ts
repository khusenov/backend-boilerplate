import { toDomain } from './prisma-role-mapper';
import { mapPrismaError } from './prisma-error';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { Role } from '@/domain/authorization/role-entity';
import type { PageQuery, PageSlice } from '@/shared/pagination';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

const ROLE_INCLUDE = {
  permissions: { select: { permission: { select: { key: true } } } },
} as const;

interface PrismaRoleRepositoryDeps {
  prisma: PrismaTransactionalClient;
}

export class PrismaRoleRepository implements RoleRepository {
  private readonly prisma: PrismaTransactionalClient;

  constructor({ prisma }: PrismaRoleRepositoryDeps) {
    this.prisma = prisma;
  }

  async list(query: PageQuery): Promise<PageSlice<Role>> {
    const where = { deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        include: ROLE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.role.count({ where }),
    ]);
    return { items: rows.map(toDomain), total };
  }

  async findById(id: string): Promise<Role | null> {
    const row = await this.prisma.role.findFirst({
      where: { id, deletedAt: null },
      include: ROLE_INCLUDE,
    });
    return row ? toDomain(row) : null;
  }

  async findByKey(key: string): Promise<Role | null> {
    const row = await this.prisma.role.findUnique({ where: { key }, include: ROLE_INCLUDE });
    return row ? toDomain(row) : null;
  }

  async findByName(name: string): Promise<Role | null> {
    const row = await this.prisma.role.findFirst({
      where: { name, deletedAt: null },
      include: ROLE_INCLUDE,
    });
    return row ? toDomain(row) : null;
  }

  async save(role: Role): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.upsert({
          where: { id: role.id },
          create: {
            id: role.id,
            key: role.key,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
            deletedAt: role.deletedAt,
          },
          update: {
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            updatedAt: role.updatedAt,
            deletedAt: role.deletedAt,
          },
        });

        const desiredKeys = role.permissions;
        const matched = desiredKeys.length
          ? await tx.permission.findMany({
              where: { key: { in: desiredKeys } },
              select: { id: true },
            })
          : [];
        const desiredIds = new Set(matched.map((p) => p.id));

        const current = await tx.rolePermission.findMany({
          where: { roleId: role.id },
          select: { permissionId: true },
        });
        const currentIds = new Set(current.map((c) => c.permissionId));

        const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));
        const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));

        if (toRemove.length) {
          await tx.rolePermission.deleteMany({
            where: { roleId: role.id, permissionId: { in: toRemove } },
          });
        }
        if (toAdd.length) {
          await tx.rolePermission.createMany({
            data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
          });
        }
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }
}
