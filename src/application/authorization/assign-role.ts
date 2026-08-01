import type { UserRepository } from '@/domain/user/user-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { UserNotFoundError } from '@/domain/user/user-errors';
import { RoleNotFoundError, SystemRoleProtectedError } from '@/domain/authorization/role-errors';

export interface AssignRoleInput {
  userId: string;
  roleId: string;
}

export type AssignRoleOutput = void;

interface AssignRoleDeps {
  userRepository: UserRepository;
  roleRepository: RoleRepository;
  userRoleRepository: UserRoleRepository;
  clock: Clock;
}

export class AssignRole {
  private readonly users: UserRepository;
  private readonly roles: RoleRepository;
  private readonly userRoles: UserRoleRepository;
  private readonly clock: Clock;

  constructor({ userRepository, roleRepository, userRoleRepository, clock }: AssignRoleDeps) {
    this.users = userRepository;
    this.roles = roleRepository;
    this.userRoles = userRoleRepository;
    this.clock = clock;
  }

  async execute(input: AssignRoleInput): Promise<AssignRoleOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new UserNotFoundError(input.userId);

    const role = await this.roles.findById(input.roleId);
    if (!role) throw new RoleNotFoundError(input.roleId);

    if (role.isSystem) throw new SystemRoleProtectedError(role.id);

    await this.userRoles.assign(user.id, role.id, this.clock.now());
  }
}
