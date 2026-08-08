export interface VerificationEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function renderVerificationEmail(code: string): VerificationEmailContent {
  const subject = 'Verify your email address';
  const text =
    `Your verification code is ${code}. ` +
    `It will expire shortly. If you did not create an account, you can ignore this email.`;
  const html =
    `<p>Your verification code is <strong>${code}</strong>.</p>` +
    `<p>It will expire shortly. If you did not create an account, you can ignore this email.</p>`;
  return { subject, text, html };
}
