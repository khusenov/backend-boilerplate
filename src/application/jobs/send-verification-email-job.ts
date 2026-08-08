export const SEND_VERIFICATION_EMAIL_JOB = 'email.send-verification';

export interface SendVerificationEmailPayload {
  email: string;
  code: string;
}
