import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { toUserDto, type UserDto } from '@/application/user/user-dto';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';

export interface RegisterUserInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export type RegisterUserOutput = UserDto;

export interface RegisterUserDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  verificationCodeIssuer: VerificationCodeIssuer;
  jobQueue: JobQueue;
  idGenerator: IdGenerator;
  clock: Clock;
}

export class RegisterUser {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly codeIssuer: VerificationCodeIssuer;
  private readonly queue: JobQueue;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  constructor({
    unitOfWork,
    userRepository,
    passwordHasher,
    verificationCodeIssuer,
    jobQueue,
    idGenerator,
    clock,
  }: RegisterUserDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.hasher = passwordHasher;
    this.codeIssuer = verificationCodeIssuer;
    this.queue = jobQueue;
    this.ids = idGenerator;
    this.clock = clock;
  }

  async execute(input: RegisterUserInput): Promise<RegisterUserOutput> {
    const email = Email.create(input.email);

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) throw new EmailAlreadyTakenError(email.toString());

    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now();

    const user = User.register(
      {
        id: this.ids.generate(),
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        passwordHash,
      },
      now,
    );

    const { code, rawCode } = this.codeIssuer.issue(user.id, now);

    await this.uow.run(async ({ userRepository, emailVerificationCodeRepository, outbox }) => {
      await userRepository.save(user);
      await emailVerificationCodeRepository.create(code);
      outbox.stage(user.pullDomainEvents());
    });

    const payload: SendVerificationEmailPayload = { email: email.toString(), code: rawCode };
    await this.queue.enqueue(SEND_VERIFICATION_EMAIL_JOB, payload);

    return toUserDto(user);
  }
}
