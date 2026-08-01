import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { UserNotFoundError } from '@/domain/user/user-errors';

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

  async execute(input: DeleteUserInput): Promise<DeleteUserOutput> {
    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);
    user.softDelete(this.clock.now());
    await this.users.save(user);
  }
}
