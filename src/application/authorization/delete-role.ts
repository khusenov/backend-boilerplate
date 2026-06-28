import type { RoleRepository } from '@/domain/authorization/role-repository';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';

export interface DeleteRoleInput {
  id: string;
}

export type DeleteRoleOutput = void;

interface DeleteRoleDeps {
  roleRepository: RoleRepository;
}

export class DeleteRole {
  private readonly roles: RoleRepository;

  constructor({ roleRepository }: DeleteRoleDeps) {
    this.roles = roleRepository;
  }

  async execute(input: DeleteRoleInput): Promise<DeleteRoleOutput> {
    const role = await this.roles.findById(input.id);
    if (!role) throw new RoleNotFoundError(input.id);
    role.softDelete();
    await this.roles.save(role);
  }
}
