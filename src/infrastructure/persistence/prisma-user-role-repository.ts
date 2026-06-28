import { mapPrismaError } from './prisma-error';
import type { PrismaClient } from '@/generated/prisma/client';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';

interface PrismaUserRoleRepositoryDeps {
  prisma: PrismaClient;
}

export class PrismaUserRoleRepository implements UserRoleRepository {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: PrismaUserRoleRepositoryDeps) {
    this.prisma = prisma;
  }

  async listRoleIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });
    return rows.map((r) => r.roleId);
  }

  async assign(userId: string, roleId: string, grantedAt: Date): Promise<void> {
    try {
      await this.prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId } },
        create: { userId, roleId, createdAt: grantedAt },
        update: {},
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    try {
      await this.prisma.userRole.deleteMany({ where: { userId, roleId } });
    } catch (error) {
      mapPrismaError(error);
    }
  }
}
