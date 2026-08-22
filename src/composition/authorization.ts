import { asClass } from 'awilix';
import { AssignRole } from '@/application/authorization/assign-role';
import { CreateRole } from '@/application/authorization/create-role';
import { DeleteRole } from '@/application/authorization/delete-role';
import { EditRole } from '@/application/authorization/edit-role';
import { GetRole } from '@/application/authorization/get-role';
import { ListPermissions } from '@/application/authorization/list-permissions';
import { ListRoles } from '@/application/authorization/list-roles';
import { RevokeRole } from '@/application/authorization/revoke-role';
import { SyncAuthorization } from '@/application/authorization/sync-authorization';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    createRole: CreateRole;
    getRole: GetRole;
    listRoles: ListRoles;
    editRole: EditRole;
    deleteRole: DeleteRole;
    assignRole: AssignRole;
    revokeRole: RevokeRole;
    listPermissions: ListPermissions;
    syncAuthorization: SyncAuthorization;
  }
}

export const authorizationRegistrations = {
  createRole: asClass(CreateRole).singleton(),
  getRole: asClass(GetRole).singleton(),
  listRoles: asClass(ListRoles).singleton(),
  editRole: asClass(EditRole).singleton(),
  deleteRole: asClass(DeleteRole).singleton(),
  assignRole: asClass(AssignRole).singleton(),
  revokeRole: asClass(RevokeRole).singleton(),
  listPermissions: asClass(ListPermissions).singleton(),
  syncAuthorization: asClass(SyncAuthorization).singleton(),
} satisfies RegistrationMap;
