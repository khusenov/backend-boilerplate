import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import { toUserDto, type UserDto } from '@/application/user/user-dto';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';
import type { VerificationConfig } from '@/application/auth/verification-config';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { JobQueue } from '@/application/shared/ports/job-queue';

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
  verificationCodeService: VerificationCodeService;
  jobQueue: JobQueue;
  idGenerator: IdGenerator;
  clock: Clock;
  verificationConfig: VerificationConfig;
}

const MILLISECONDS_PER_SECOND = 1000;

export class RegisterUser {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly codes: VerificationCodeService;
  private readonly queue: JobQueue;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly config: VerificationConfig;

  constructor({
    unitOfWork,
    userRepository,
    passwordHasher,
    verificationCodeService,
    jobQueue,
    idGenerator,
    clock,
    verificationConfig,
  }: RegisterUserDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.hasher = passwordHasher;
    this.codes = verificationCodeService;
    this.queue = jobQueue;
    this.ids = idGenerator;
    this.clock = clock;
    this.config = verificationConfig;
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

    const rawCode = this.codes.generate();
    const code = EmailVerificationCode.issue(
      {
        id: this.ids.generate(),
        userId: user.id,
        codeHash: this.codes.hash(rawCode),
        expiresAt: new Date(now.getTime() + this.config.ttlSeconds * MILLISECONDS_PER_SECOND),
        maxAttempts: this.config.maxAttempts,
      },
      now,
    );

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
