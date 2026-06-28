import type { UserRepository } from '@/domain/user/user-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';

export interface RevokeRoleInput {
  userId: string;
  roleId: string;
}

export type RevokeRoleOutput = void;

interface RevokeRoleDeps {
  userRepository: UserRepository;
  userRoleRepository: UserRoleRepository;
}

export class RevokeRole {
  private readonly users: UserRepository;
  private readonly userRoles: UserRoleRepository;

  constructor({ userRepository, userRoleRepository }: RevokeRoleDeps) {
    this.users = userRepository;
    this.userRoles = userRoleRepository;
  }

  async execute(input: RevokeRoleInput): Promise<RevokeRoleOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new UserNotFoundError(input.userId);

    await this.userRoles.revoke(user.id, input.roleId);
  }
}
