import { ValidationError } from '@/shared/errors';

export class VerificationCodeInvalidError extends ValidationError {
  constructor() {
    super('Verification code is invalid', { code: 'VERIFICATION_CODE_INVALID' });
  }
}

export class VerificationCodeExpiredError extends ValidationError {
  constructor() {
    super('Verification code has expired', { code: 'VERIFICATION_CODE_EXPIRED' });
  }
}

export class TooManyVerificationAttemptsError extends ValidationError {
  constructor() {
    super('Too many verification attempts', { code: 'TOO_MANY_VERIFICATION_ATTEMPTS' });
  }
}
