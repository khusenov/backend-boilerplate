import type { GrantsReader, UserGrants } from '@/application/shared/ports/grants-reader';
import type { PrismaClient } from '@/generated/prisma/client';

interface PrismaGrantsReaderDeps {
  prisma: PrismaClient;
}

export class PrismaGrantsReader implements GrantsReader {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: PrismaGrantsReaderDeps) {
    this.prisma = prisma;
  }

  async grantsFor(userId: string): Promise<UserGrants> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId, role: { deletedAt: null } },
      select: {
        role: {
          select: {
            key: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });

    const systemRoleKeys = rows.map((r) => r.role.key).filter((k) => k !== null);

    const permissions = new Set<string>();
    for (const r of rows) {
      for (const rp of r.role.permissions) {
        permissions.add(rp.permission.key);
      }
    }

    return { systemRoleKeys, permissions: [...permissions] };
  }
}
