import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { EmailSender } from '@/application/shared/ports/email-sender';
import { renderPasswordResetEmail } from '@/application/auth/password-reset-email-content';
import {
  SEND_PASSWORD_RESET_EMAIL_JOB,
  type SendPasswordResetEmailPayload,
} from '@/application/jobs/send-password-reset-email-job';

export interface SendPasswordResetEmailHandlerDeps {
  emailSender: EmailSender;
  passwordResetUrlBase: string;
}

export class SendPasswordResetEmailHandler implements JobHandler<
  SendPasswordResetEmailPayload,
  typeof SEND_PASSWORD_RESET_EMAIL_JOB
> {
  readonly jobName = SEND_PASSWORD_RESET_EMAIL_JOB;
  private readonly emailSender: EmailSender;
  private readonly urlBase: string;

  constructor({ emailSender, passwordResetUrlBase }: SendPasswordResetEmailHandlerDeps) {
    this.emailSender = emailSender;
    this.urlBase = passwordResetUrlBase;
  }

  async handle(payload: SendPasswordResetEmailPayload): Promise<void> {
    const resetUrl = `${this.urlBase}?token=${encodeURIComponent(payload.token)}`;
    const content = renderPasswordResetEmail(resetUrl);
    await this.emailSender.send({
      to: payload.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }
}
