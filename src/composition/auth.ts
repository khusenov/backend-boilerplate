import { asClass, asValue } from 'awilix';
import { env } from '@/config/env';
import { SessionService } from '@/application/auth/session-service';
import { Login } from '@/application/auth/login';
import { RefreshSession } from '@/application/auth/refresh-session';
import { Logout } from '@/application/auth/logout';
import { RegisterUser } from '@/application/auth/register-user';
import { VerifyEmail } from '@/application/auth/verify-email';
import { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';
import type { VerificationConfig } from '@/application/auth/verification-config';
import { PasswordResetTokenIssuer } from '@/application/auth/password-reset-token-issuer';
import { RequestPasswordReset } from '@/application/auth/request-password-reset';
import { ResetPassword } from '@/application/auth/reset-password';
import type { PasswordResetConfig } from '@/application/auth/password-reset-config';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    sessionService: SessionService;
    login: Login;
    refreshSession: RefreshSession;
    logout: Logout;
    registerUser: RegisterUser;
    verifyEmail: VerifyEmail;
    verificationCodeIssuer: VerificationCodeIssuer;
    verificationConfig: VerificationConfig;
    passwordResetTokenIssuer: PasswordResetTokenIssuer;
    requestPasswordReset: RequestPasswordReset;
    resetPassword: ResetPassword;
    passwordResetConfig: PasswordResetConfig;
    passwordResetUrlBase: string;
  }
}

export const authRegistrations = {
  sessionService: asClass(SessionService).singleton(),
  login: asClass(Login).singleton(),
  refreshSession: asClass(RefreshSession).singleton(),
  logout: asClass(Logout).singleton(),
  registerUser: asClass(RegisterUser).singleton(),
  verifyEmail: asClass(VerifyEmail).singleton(),
  verificationCodeIssuer: asClass(VerificationCodeIssuer).singleton(),
  verificationConfig: asValue({
    ttlSeconds: env.VERIFICATION_CODE_TTL,
    maxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
  }),
  passwordResetTokenIssuer: asClass(PasswordResetTokenIssuer).singleton(),
  requestPasswordReset: asClass(RequestPasswordReset).singleton(),
  resetPassword: asClass(ResetPassword).singleton(),
  passwordResetConfig: asValue({ ttlSeconds: env.PASSWORD_RESET_TOKEN_TTL }),
  passwordResetUrlBase: asValue(env.PASSWORD_RESET_URL_BASE),
} satisfies RegistrationMap;
