import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { Clock } from '@/application/shared/ports/clock';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface DeleteRoleInput {
  id: string;
}

export type DeleteRoleOutput = void;

interface DeleteRoleDeps {
  unitOfWork: UnitOfWork;
  clock: Clock;
}

export class DeleteRole {
  private readonly unitOfWork: UnitOfWork;
  private readonly clock: Clock;

  constructor({ unitOfWork, clock }: DeleteRoleDeps) {
    this.unitOfWork = unitOfWork;
    this.clock = clock;
  }

  async execute(input: DeleteRoleInput, actor: Actor): Promise<DeleteRoleOutput> {
    ensurePermission(actor, PERMISSIONS.RolesDelete.key);

    await this.unitOfWork.run(async ({ roleRepository }) => {
      const role = await roleRepository.findById(input.id);
      if (!role) throw new RoleNotFoundError(input.id);
      role.softDelete(this.clock.now());
      await roleRepository.save(role);
    });
  }
}
