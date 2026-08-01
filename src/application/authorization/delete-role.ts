import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';

export interface DeleteRoleInput {
  id: string;
}

export type DeleteRoleOutput = void;

interface DeleteRoleDeps {
  roleRepository: RoleRepository;
  clock: Clock;
}

export class DeleteRole {
  private readonly roles: RoleRepository;
  private readonly clock: Clock;

  constructor({ roleRepository, clock }: DeleteRoleDeps) {
    this.roles = roleRepository;
    this.clock = clock;
  }

  async execute(input: DeleteRoleInput): Promise<DeleteRoleOutput> {
    const role = await this.roles.findById(input.id);
    if (!role) throw new RoleNotFoundError(input.id);
    role.softDelete(this.clock.now());
    await this.roles.save(role);
  }
}
