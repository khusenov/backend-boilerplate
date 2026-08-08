import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { EmailSender } from '@/application/shared/ports/email-sender';
import { renderVerificationEmail } from '@/application/auth/verification-email-content';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';

export interface SendVerificationEmailHandlerDeps {
  emailSender: EmailSender;
}

export class SendVerificationEmailHandler implements JobHandler<SendVerificationEmailPayload> {
  readonly jobName = SEND_VERIFICATION_EMAIL_JOB;
  private readonly emailSender: EmailSender;

  constructor({ emailSender }: SendVerificationEmailHandlerDeps) {
    this.emailSender = emailSender;
  }

  async handle(payload: SendVerificationEmailPayload): Promise<void> {
    const content = renderVerificationEmail(payload.code);
    await this.emailSender.send({
      to: payload.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }
}
