import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodemailerEmailSender, type NodemailerEmailSenderDeps } from './nodemailer-email-sender';

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue(undefined);
  return {
    mockSendMail,
    mockCreateTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

function makeDeps(overrides: Partial<NodemailerEmailSenderDeps> = {}): NodemailerEmailSenderDeps {
  return {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    requireTls: true,
    user: '',
    password: '',
    from: 'no-reply@app.local',
    ...overrides,
  };
}

describe('NodemailerEmailSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('builds the transport from the SMTP config', () => {
      new NodemailerEmailSender(
        makeDeps({ host: 'mail.internal', port: 465, secure: true, requireTls: true }),
      );

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'mail.internal',
          port: 465,
          secure: true,
          requireTLS: true,
        }),
      );
    });

    it('omits auth when no SMTP user is configured', () => {
      new NodemailerEmailSender(makeDeps({ user: '' }));

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: undefined }),
      );
    });

    it('passes auth credentials when an SMTP user is configured', () => {
      new NodemailerEmailSender(makeDeps({ user: 'mailer', password: 's3cret' }));

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'mailer', pass: 's3cret' } }),
      );
    });
  });

  describe('send', () => {
    it('maps the message and From address onto sendMail', async () => {
      const sut = new NodemailerEmailSender(makeDeps({ from: 'hello@example.com' }));

      await sut.send({
        to: 'user@example.com',
        subject: 'Your code',
        text: 'Code: 123456',
        html: '<b>123456</b>',
      });

      expect(mockSendMail).toHaveBeenCalledWith({
        from: 'hello@example.com',
        to: 'user@example.com',
        subject: 'Your code',
        text: 'Code: 123456',
        html: '<b>123456</b>',
      });
    });

    it('propagates transport failures instead of swallowing them', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
      const sut = new NodemailerEmailSender(makeDeps());

      await expect(sut.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow(
        'smtp down',
      );
    });
  });
});
