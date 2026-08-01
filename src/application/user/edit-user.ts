import { toUserDto, type UserDto } from '@/application/user/user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { EmailAlreadyTakenError, UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';

export interface EditUserInput {
  id: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | undefined;
}

export type EditUserOutput = UserDto;

interface EditUserDeps {
  userRepository: UserRepository;
  clock: Clock;
}

export class EditUser {
  private readonly users: UserRepository;
  private readonly clock: Clock;

  constructor({ userRepository, clock }: EditUserDeps) {
    this.users = userRepository;
    this.clock = clock;
  }

  async execute(input: EditUserInput): Promise<EditUserOutput> {
    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);

    const now = this.clock.now();

    if (input.email !== undefined) {
      const email = Email.create(input.email);
      if (!user.email.equals(email)) {
        const existingUser = await this.users.findByEmail(email);
        if (existingUser) throw new EmailAlreadyTakenError(email.toString());
        user.changeEmail(email, now);
      }
    }

    if (input.firstName !== undefined) user.changeFirstName(input.firstName, now);
    if (input.lastName !== undefined) user.changeLastName(input.lastName, now);

    await this.users.save(user);
    return toUserDto(user);
  }
}
