import { PasswordResetTokenInvalidError } from '@/domain/password-reset/password-reset-errors';
import {
  REVOKE_USER_SESSIONS_JOB,
  type RevokeUserSessionsPayload,
} from '@/application/jobs/revoke-user-sessions-job';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Clock } from '@/application/shared/ports/clock';

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export type ResetPasswordOutput = void;

export interface ResetPasswordDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  passwordResetTokenRepository: PasswordResetTokenRepository;
  passwordHasher: PasswordHasher;
  opaqueTokenService: OpaqueTokenService;
  jobQueue: JobQueue;
  clock: Clock;
}

export class ResetPassword {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly resetTokens: PasswordResetTokenRepository;
  private readonly hasher: PasswordHasher;
  private readonly opaqueTokens: OpaqueTokenService;
  private readonly queue: JobQueue;
  private readonly clock: Clock;

  constructor({
    unitOfWork,
    userRepository,
    passwordResetTokenRepository,
    passwordHasher,
    opaqueTokenService,
    jobQueue,
    clock,
  }: ResetPasswordDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.resetTokens = passwordResetTokenRepository;
    this.hasher = passwordHasher;
    this.opaqueTokens = opaqueTokenService;
    this.queue = jobQueue;
    this.clock = clock;
  }

  async execute(input: ResetPasswordInput): Promise<void> {
    const tokenHash = this.opaqueTokens.hash(input.token);
    const resetToken = await this.resetTokens.findByTokenHash(tokenHash);
    if (!resetToken) throw new PasswordResetTokenInvalidError();

    // Soft-deleted users aren't cascade-removed, so their reset token can still resolve
    // here; findById excludes soft-deleted users, which is what stops a stale token from
    // reactivating access to a deleted account. Resolved before consume() so a missing
    // user is rejected without spending the token.
    const user = await this.users.findById(resetToken.userId);
    if (!user) throw new PasswordResetTokenInvalidError();

    const now = this.clock.now();
    resetToken.consume(now);

    const newPasswordHash = await this.hasher.hash(input.newPassword);
    user.changePassword(newPasswordHash, now);
    // A clicked, mailed reset link proves mailbox ownership at least as strongly as the
    // verification code it would otherwise take, so it also clears a never-verified
    // account's Pending status. A deliberately deactivated account is left as-is — this
    // isn't the flow that should silently undo that.
    if (user.isPending) {
      user.activate(now);
    }

    await this.uow.run(async ({ userRepository, passwordResetTokenRepository }) => {
      await userRepository.save(user);
      await passwordResetTokenRepository.update(resetToken);
    });

    const payload: RevokeUserSessionsPayload = { userId: user.id };
    await this.queue.enqueue(REVOKE_USER_SESSIONS_JOB, payload);
  }
}
