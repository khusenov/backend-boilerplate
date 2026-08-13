import { groupPermissions, type PermissionGroupDto } from './permission-dto';
import { ALL_PERMISSIONS, PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';

export type ListPermissionsOutput = PermissionGroupDto[];

export class ListPermissions {
  execute(actor: Actor): ListPermissionsOutput {
    ensurePermission(actor, PERMISSIONS.RolesRead.key);

    return groupPermissions(ALL_PERMISSIONS);
  }
}
