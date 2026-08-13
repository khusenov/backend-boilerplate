export interface PasswordResetEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function renderPasswordResetEmail(resetUrl: string): PasswordResetEmailContent {
  const subject = 'Reset your password';
  const text =
    `We received a request to reset your password. Use the link below to choose a new one: ${resetUrl} ` +
    `This link will expire shortly. If you did not request a password reset, you can ignore this email.`;
  const html =
    `<p>We received a request to reset your password. ` +
    `<a href="${resetUrl}">Click here to choose a new password</a>.</p>` +
    `<p>This link will expire shortly. If you did not request a password reset, you can ignore this email.</p>`;
  return { subject, text, html };
}
