import { describe, expect, it, vi } from 'vitest';
import { SEND_PASSWORD_RESET_EMAIL_JOB } from '@/application/jobs/send-password-reset-email-job';
import { SendPasswordResetEmailHandler } from '@/application/jobs/send-password-reset-email-handler';
import { renderPasswordResetEmail } from '@/application/auth/password-reset-email-content';
import type { EmailSender } from '@/application/shared/ports/email-sender';

const URL_BASE = 'http://localhost:3000/reset-password';

function makeHandler() {
  const send = vi.fn<EmailSender['send']>().mockResolvedValue(undefined);
  const handler = new SendPasswordResetEmailHandler({
    emailSender: { send },
    passwordResetUrlBase: URL_BASE,
  });

  return { handler, send };
}

describe('SendPasswordResetEmailHandler', () => {
  it('exposes the send-password-reset job name', () => {
    expect(makeHandler().handler.jobName).toBe(SEND_PASSWORD_RESET_EMAIL_JOB);
  });

  it('sends exactly one message to the payload address', async () => {
    const { handler, send } = makeHandler();

    await handler.handle({ email: 'ada@example.com', token: 'raw-token' });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].to).toBe('ada@example.com');
  });

  it('builds the reset url from the configured base and the token, then renders it', async () => {
    const { handler, send } = makeHandler();
    const expected = renderPasswordResetEmail(`${URL_BASE}?token=raw-token`);

    await handler.handle({ email: 'ada@example.com', token: 'raw-token' });

    expect(send).toHaveBeenCalledWith({
      to: 'ada@example.com',
      subject: expected.subject,
      text: expected.text,
      html: expected.html,
    });
  });

  it('percent-encodes a token containing URL-sensitive characters', async () => {
    const { handler, send } = makeHandler();

    await handler.handle({ email: 'ada@example.com', token: 'a+b/c=' });

    expect(send.mock.calls[0]![0].text).toContain(`${URL_BASE}?token=a%2Bb%2Fc%3D`);
  });

  it('propagates a delivery failure so the worker can retry', async () => {
    const { handler, send } = makeHandler();
    send.mockRejectedValue(new Error('smtp down'));

    await expect(handler.handle({ email: 'ada@example.com', token: 'raw-token' })).rejects.toThrow(
      'smtp down',
    );
  });
});
