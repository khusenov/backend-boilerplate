import type { UserRepository } from '@/domain/user/user-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';

export interface DeleteUserInput {
  id: string;
}

export type DeleteUserOutput = void;

interface DeleteUserDeps {
  userRepository: UserRepository;
}

export class DeleteUser {
  private readonly users: UserRepository;

  constructor({ userRepository }: DeleteUserDeps) {
    this.users = userRepository;
  }

  async execute(input: DeleteUserInput): Promise<DeleteUserOutput> {
    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);
    user.softDelete();
    await this.users.save(user);
  }
}
