export const SEND_PASSWORD_RESET_EMAIL_JOB = 'email.send-password-reset';

export interface SendPasswordResetEmailPayload {
  email: string;
  token: string;
}
