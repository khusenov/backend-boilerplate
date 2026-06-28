import type { Role } from '@/domain/authorization/role-entity';

export interface RoleDto {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toRoleDto(role: Role): RoleDto {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
