import { toRoleDto, type RoleDto } from './role-dto';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface GetRoleInput {
  id: string;
}

export type GetRoleOutput = RoleDto;

interface GetRoleDeps {
  roleRepository: RoleRepository;
}

export class GetRole {
  private readonly roles: RoleRepository;

  constructor({ roleRepository }: GetRoleDeps) {
    this.roles = roleRepository;
  }

  async execute(input: GetRoleInput, actor: Actor): Promise<GetRoleOutput> {
    ensurePermission(actor, PERMISSIONS.RolesRead.key);

    const role = await this.roles.findById(input.id);
    if (!role) throw new RoleNotFoundError(input.id);
    return toRoleDto(role);
  }
}
