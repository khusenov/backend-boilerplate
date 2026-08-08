import { describe, expect, it, vi } from 'vitest';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';
import { SendVerificationEmailHandler } from '@/application/jobs/send-verification-email-handler';
import { renderVerificationEmail } from '@/application/auth/verification-email-content';
import type { EmailSender } from '@/application/shared/ports/email-sender';

function makeHandler() {
  const send = vi.fn<EmailSender['send']>().mockResolvedValue(undefined);
  const handler = new SendVerificationEmailHandler({ emailSender: { send } });

  return { handler, send };
}

describe('SendVerificationEmailHandler', () => {
  it('exposes the send-verification job name', () => {
    expect(makeHandler().handler.jobName).toBe(SEND_VERIFICATION_EMAIL_JOB);
  });

  it('sends exactly one message to the payload address', async () => {
    const { handler, send } = makeHandler();

    await handler.handle({ email: 'ada@example.com', code: '123456' });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].to).toBe('ada@example.com');
  });

  it('sends the rendered subject, text, and html', async () => {
    const { handler, send } = makeHandler();
    const expected = renderVerificationEmail('123456');

    await handler.handle({ email: 'ada@example.com', code: '123456' });

    expect(send).toHaveBeenCalledWith({
      to: 'ada@example.com',
      subject: expected.subject,
      text: expected.text,
      html: expected.html,
    });
  });

  it('propagates a delivery failure so the worker can retry', async () => {
    const { handler, send } = makeHandler();
    send.mockRejectedValue(new Error('smtp down'));

    await expect(handler.handle({ email: 'ada@example.com', code: '123456' })).rejects.toThrow(
      'smtp down',
    );
  });
});
