import { toRoleDto, type RoleDto } from './role-dto';
import { assertKnownPermissions } from './assert-known-permissions';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { Clock } from '@/application/shared/ports/clock';
import type { Role } from '@/domain/authorization/role-entity';
import type { RoleReader } from '@/domain/authorization/role-repository';
import { RoleNameTakenError, RoleNotFoundError } from '@/domain/authorization/role-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface EditRoleInput {
  id: string;
  name?: string | undefined;
  description?: string | null | undefined;
  permissions?: string[] | undefined;
}

export type EditRoleOutput = RoleDto;

interface EditRoleDeps {
  unitOfWork: UnitOfWork;
  clock: Clock;
}

export class EditRole {
  private readonly unitOfWork: UnitOfWork;
  private readonly clock: Clock;

  constructor({ unitOfWork, clock }: EditRoleDeps) {
    this.unitOfWork = unitOfWork;
    this.clock = clock;
  }

  async execute(input: EditRoleInput, actor: Actor): Promise<EditRoleOutput> {
    ensurePermission(actor, PERMISSIONS.RolesUpdate.key);
    if (input.permissions !== undefined) assertKnownPermissions(input.permissions);

    return this.unitOfWork.run(async ({ roleRepository }) => {
      const role = await roleRepository.findById(input.id);
      if (!role) throw new RoleNotFoundError(input.id);

      await this.applyChanges(role, input, roleRepository);

      await roleRepository.save(role);
      return toRoleDto(role);
    });
  }

  private async applyChanges(role: Role, input: EditRoleInput, roles: RoleReader): Promise<void> {
    const now = this.clock.now();

    if (input.name !== undefined) {
      const existing = await roles.findByName(input.name.trim());
      if (existing && existing.id !== role.id) throw new RoleNameTakenError(input.name.trim());
      role.rename(input.name, now);
    }

    if (input.description !== undefined) role.changeDescription(input.description, now);
    if (input.permissions !== undefined) role.setPermissions(input.permissions, now);
  }
}
