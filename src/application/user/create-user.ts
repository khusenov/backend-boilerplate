import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { toUserDto, type UserDto } from '@/application/user/user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export type CreateUserOutput = UserDto;

export interface CreateUserDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  idGenerator: IdGenerator;
}

export class CreateUser {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly ids: IdGenerator;

  constructor({ unitOfWork, userRepository, passwordHasher, idGenerator }: CreateUserDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.hasher = passwordHasher;
    this.ids = idGenerator;
  }

  async execute(input: CreateUserInput): Promise<CreateUserOutput> {
    const email = Email.create(input.email);

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) throw new EmailAlreadyTakenError(email.toString());

    const passwordHash = await this.hasher.hash(input.password);

    const newUser = User.create({
      id: this.ids.generate(),
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      passwordHash,
    });

    await this.uow.run(async ({ userRepository, outbox }) => {
      await userRepository.save(newUser);
      outbox.stage(newUser.pullDomainEvents());
    });

    return toUserDto(newUser);
  }
}
