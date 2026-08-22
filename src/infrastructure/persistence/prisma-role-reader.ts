import { toDomain } from './prisma-role-mapper';
import type { RoleReader } from '@/domain/authorization/role-repository';
import type { Role } from '@/domain/authorization/role-entity';
import type { PageQuery, PageSlice } from '@/shared/pagination';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

const ROLE_INCLUDE = {
  permissions: { select: { permission: { select: { key: true } } } },
} as const;

interface PrismaRoleReaderDeps {
  prisma: PrismaTransactionalClient;
}

export class PrismaRoleReader implements RoleReader {
  protected readonly prisma: PrismaTransactionalClient;

  constructor({ prisma }: PrismaRoleReaderDeps) {
    this.prisma = prisma;
  }

  async list(query: PageQuery): Promise<PageSlice<Role>> {
    const where = { deletedAt: null };
    const rows = await this.prisma.role.findMany({
      where,
      include: ROLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    const total = await this.prisma.role.count({ where });
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
}
