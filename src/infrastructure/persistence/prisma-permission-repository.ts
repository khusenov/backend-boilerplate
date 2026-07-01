import { mapPrismaError } from './prisma-error';
import type { PrismaTransactionalClient } from './prisma-transactional-client';
import type {
  PermissionRecord,
  PermissionRepository,
} from '@/application/shared/ports/permission-repository';

interface PrismaPermissionRepositoryDeps {
  prisma: PrismaTransactionalClient;
}

export class PrismaPermissionRepository implements PermissionRepository {
  private readonly prisma: PrismaTransactionalClient;

  constructor({ prisma }: PrismaPermissionRepositoryDeps) {
    this.prisma = prisma;
  }

  async findAll(): Promise<PermissionRecord[]> {
    return this.prisma.permission.findMany();
  }

  async upsertByKey(record: PermissionRecord): Promise<void> {
    try {
      await this.prisma.permission.upsert({
        where: { key: record.key },
        create: record,
        update: {
          name: record.name,
          description: record.description,
          category: record.category,
          updatedAt: record.updatedAt,
        },
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async deleteByKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.prisma.permission.deleteMany({ where: { key: { in: keys } } });
    } catch (error) {
      mapPrismaError(error);
    }
  }
}
