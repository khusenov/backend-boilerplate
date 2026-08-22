import { asFunction } from 'awilix';
import { env } from '@/config/env';
import type { EmailSender } from '@/application/shared/ports/email-sender';
import { NodemailerEmailSender } from '@/infrastructure/email/nodemailer-email-sender';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    emailSender: EmailSender;
  }
}

export const emailRegistrations = {
  emailSender: asFunction(
    () =>
      new NodemailerEmailSender({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        requireTls: env.SMTP_REQUIRE_TLS,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.EMAIL_FROM,
      }),
  ).singleton(),
} satisfies RegistrationMap;
