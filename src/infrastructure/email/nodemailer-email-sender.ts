import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender, EmailMessage } from '@/application/shared/ports/email-sender';

export interface NodemailerEmailSenderDeps {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  password: string;
  from: string;
}

export class NodemailerEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor({ host, port, secure, requireTls, user, password, from }: NodemailerEmailSenderDeps) {
    this.from = from;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: requireTls,
      auth: user ? { user, pass: password } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
