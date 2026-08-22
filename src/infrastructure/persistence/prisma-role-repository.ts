import { PrismaRoleReader } from './prisma-role-reader';
import { toPersistence } from './prisma-role-mapper';
import { mapPrismaError } from './prisma-error';
import { UNSAVED_VERSION } from '@/domain/shared/aggregate-root';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { Role } from '@/domain/authorization/role-entity';
import type { Role as RoleRow } from '@/generated/prisma/client';

const ROLE_AGGREGATE_NAME = 'Role';

type MutableRoleFields = Omit<RoleRow, 'id' | 'createdAt'>;

export class PrismaRoleRepository extends PrismaRoleReader implements RoleRepository {
  async save(role: Role): Promise<void> {
    const { id, createdAt, ...current } = toPersistence(role);
    const expectedVersion = current.version;
    const next: MutableRoleFields = { ...current, version: expectedVersion + 1 };

    if (expectedVersion === UNSAVED_VERSION) {
      await this.insert({ id, createdAt, ...next });
    } else {
      const updatedRows = await this.guardedUpdate(id, expectedVersion, next);
      if (updatedRows === 0) throw new StaleAggregateError(ROLE_AGGREGATE_NAME, id);
    }

    await this.replacePermissions(role);
  }

  private async insert(row: RoleRow): Promise<void> {
    try {
      await this.prisma.role.create({ data: row });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  private async guardedUpdate(
    id: string,
    expectedVersion: number,
    data: MutableRoleFields,
  ): Promise<number> {
    try {
      const { count } = await this.prisma.role.updateMany({
        where: { id, version: expectedVersion },
        data,
      });
      return count;
    } catch (error) {
      mapPrismaError(error);
    }
  }

  private async replacePermissions(role: Role): Promise<void> {
    try {
      const desiredIds = await this.resolvePermissionIds(role.permissions);
      const currentIds = await this.currentPermissionIds(role.id);

      const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));
      const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));

      if (toRemove.length) {
        await this.prisma.rolePermission.deleteMany({
          where: { roleId: role.id, permissionId: { in: toRemove } },
        });
      }
      if (toAdd.length) {
        await this.prisma.rolePermission.createMany({
          data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
        });
      }
    } catch (error) {
      mapPrismaError(error);
    }
  }

  private async resolvePermissionIds(keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const rows = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  private async currentPermissionIds(roleId: string): Promise<Set<string>> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    });
    return new Set(rows.map((row) => row.permissionId));
  }
}
