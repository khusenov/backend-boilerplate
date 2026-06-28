import type { Role as RoleRow } from '@/generated/prisma/client';

import { Role } from '@/domain/authorization/role-entity';

type RoleRowWithPermissions = RoleRow & {
  permissions: { permission: { key: string } }[];
};

export function toDomain(row: RoleRowWithPermissions): Role {
  return Role.hydrate({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissions: new Set(row.permissions.map((rp) => rp.permission.key)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}
