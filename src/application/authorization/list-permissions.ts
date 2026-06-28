import { groupPermissions, type PermissionGroupDto } from './permission-dto';
import { ALL_PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export type ListPermissionsOutput = PermissionGroupDto[];

export class ListPermissions {
  execute(): ListPermissionsOutput {
    return groupPermissions(ALL_PERMISSIONS);
  }
}
