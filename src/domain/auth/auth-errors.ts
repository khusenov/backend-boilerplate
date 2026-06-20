import { UnauthorizedError } from '@/shared/errors';

export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }
}

export class RefreshTokenInvalidError extends UnauthorizedError {
  constructor() {
    super('Invalid or expired refresh token', { code: 'REFRESH_TOKEN_INVALID' });
  }
}

export class RefreshTokenReusedError extends UnauthorizedError {
  constructor() {
    super('Refresh token reuse detected', { code: 'REFRESH_TOKEN_REUSED' });
  }
}
