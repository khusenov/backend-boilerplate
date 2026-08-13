import { Email } from '@/domain/user/email-vo';
import {
  SEND_PASSWORD_RESET_EMAIL_JOB,
  type SendPasswordResetEmailPayload,
} from '@/application/jobs/send-password-reset-email-job';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordResetTokenIssuer } from '@/application/auth/password-reset-token-issuer';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Clock } from '@/application/shared/ports/clock';

export interface RequestPasswordResetInput {
  email: string;
}

export type RequestPasswordResetOutput = void;

export interface RequestPasswordResetDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  passwordResetTokenIssuer: PasswordResetTokenIssuer;
  jobQueue: JobQueue;
  clock: Clock;
}

export class RequestPasswordReset {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly tokenIssuer: PasswordResetTokenIssuer;
  private readonly queue: JobQueue;
  private readonly clock: Clock;

  constructor({
    unitOfWork,
    userRepository,
    passwordResetTokenIssuer,
    jobQueue,
    clock,
  }: RequestPasswordResetDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.tokenIssuer = passwordResetTokenIssuer;
    this.queue = jobQueue;
    this.clock = clock;
  }

  async execute(input: RequestPasswordResetInput): Promise<void> {
    const email = Email.create(input.email);
    const user = await this.users.findByEmail(email);
    // Unlike findById, findByEmail does not exclude soft-deleted users, so that check is
    // repeated here explicitly. Both an unknown email and a deleted account's email must
    // be silent no-ops — responding differently would let this endpoint enumerate accounts.
    // Pending and Inactive users are deliberately NOT excluded here: they can still prove
    // mailbox ownership and recover access (see ResetPassword for what each status does).
    if (!user || user.isDeleted) return;

    const now = this.clock.now();
    const { token, rawToken } = this.tokenIssuer.issue(user.id, now);

    await this.uow.run(async ({ passwordResetTokenRepository }) => {
      await passwordResetTokenRepository.invalidateAllForUser(user.id, now);
      await passwordResetTokenRepository.create(token);
    });

    const payload: SendPasswordResetEmailPayload = { email: email.toString(), token: rawToken };
    await this.queue.enqueue(SEND_PASSWORD_RESET_EMAIL_JOB, payload);
  }
}
