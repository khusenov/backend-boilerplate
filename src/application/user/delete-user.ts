import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { UserNotFoundError } from '@/domain/user/user-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface DeleteUserInput {
  id: string;
}

export type DeleteUserOutput = void;

interface DeleteUserDeps {
  userRepository: UserRepository;
  clock: Clock;
}

export class DeleteUser {
  private readonly users: UserRepository;
  private readonly clock: Clock;

  constructor({ userRepository, clock }: DeleteUserDeps) {
    this.users = userRepository;
    this.clock = clock;
  }

  async execute(input: DeleteUserInput, actor: Actor): Promise<DeleteUserOutput> {
    ensurePermission(actor, PERMISSIONS.UsersDelete.key);

    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);
    user.softDelete(this.clock.now());
    await this.users.save(user);
  }
}
