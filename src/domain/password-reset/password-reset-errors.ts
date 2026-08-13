import { ValidationError } from '@/shared/errors';

export class PasswordResetTokenInvalidError extends ValidationError {
  constructor() {
    super('Password reset token is invalid', { code: 'PASSWORD_RESET_TOKEN_INVALID' });
  }
}

export class PasswordResetTokenExpiredError extends ValidationError {
  constructor() {
    super('Password reset token has expired', { code: 'PASSWORD_RESET_TOKEN_EXPIRED' });
  }
}
