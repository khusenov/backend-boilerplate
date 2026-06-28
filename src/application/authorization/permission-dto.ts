import type { PermissionDef } from '@/domain/authorization/permission-catalogue';

export interface PermissionItemDto {
  key: string;
  name: string;
}

export interface PermissionGroupDto {
  category: string;
  permissions: PermissionItemDto[];
}

export function groupPermissions(defs: readonly PermissionDef[]): PermissionGroupDto[] {
  const groups = new Map<string, PermissionItemDto[]>();
  for (const def of defs) {
    const items = groups.get(def.category) ?? [];
    items.push({ key: def.key, name: def.name });
    groups.set(def.category, items);
  }
  return [...groups].map(([category, permissions]) => ({ category, permissions }));
}
