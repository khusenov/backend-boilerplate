import { toRoleDto, type RoleDto } from './role-dto';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';

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

  async execute(input: GetRoleInput): Promise<GetRoleOutput> {
    const role = await this.roles.findById(input.id);
    if (!role) throw new RoleNotFoundError(input.id);
    return toRoleDto(role);
  }
}
