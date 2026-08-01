import { toRoleDto, type RoleDto } from './role-dto';
import { assertKnownPermissions } from './assert-known-permissions';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { RoleNameTakenError, RoleNotFoundError } from '@/domain/authorization/role-errors';

export interface EditRoleInput {
  id: string;
  name?: string | undefined;
  description?: string | null | undefined;
  permissions?: string[] | undefined;
}

export type EditRoleOutput = RoleDto;

interface EditRoleDeps {
  roleRepository: RoleRepository;
  clock: Clock;
}

export class EditRole {
  private readonly roles: RoleRepository;
  private readonly clock: Clock;

  constructor({ roleRepository, clock }: EditRoleDeps) {
    this.roles = roleRepository;
    this.clock = clock;
  }

  async execute(input: EditRoleInput): Promise<EditRoleOutput> {
    const role = await this.roles.findById(input.id);
    if (!role) throw new RoleNotFoundError(input.id);

    if (input.permissions !== undefined) assertKnownPermissions(input.permissions);

    const now = this.clock.now();

    if (input.name !== undefined) {
      const existing = await this.roles.findByName(input.name.trim());
      if (existing && existing.id !== role.id) throw new RoleNameTakenError(input.name.trim());
      role.rename(input.name, now);
    }

    if (input.description !== undefined) role.changeDescription(input.description, now);
    if (input.permissions !== undefined) role.setPermissions(input.permissions, now);

    await this.roles.save(role);
    return toRoleDto(role);
  }
}
