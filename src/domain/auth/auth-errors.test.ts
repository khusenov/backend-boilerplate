import { describe, expect, it } from 'vitest';
import {
  InvalidCredentialsError,
  RefreshTokenInvalidError,
  RefreshTokenReusedError,
} from './auth-errors';
import { UnauthorizedError } from '@/shared/errors';
import { ErrorKind } from '@/shared/errors/app-error';

describe('InvalidCredentialsError', () => {
  it('is an instance of UnauthorizedError and Error', () => {
    const err = new InvalidCredentialsError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new InvalidCredentialsError();
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(err.kind).toBe(ErrorKind.Unauthorized);
  });

  it('has a descriptive message', () => {
    const err = new InvalidCredentialsError();
    expect(err.message).toBe('Invalid email or password');
  });

  it('has the class name as error name', () => {
    expect(new InvalidCredentialsError().name).toBe('InvalidCredentialsError');
  });
});

describe('RefreshTokenInvalidError', () => {
  it('is an instance of UnauthorizedError and Error', () => {
    const err = new RefreshTokenInvalidError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new RefreshTokenInvalidError();
    expect(err.code).toBe('REFRESH_TOKEN_INVALID');
    expect(err.kind).toBe(ErrorKind.Unauthorized);
  });

  it('has a descriptive message', () => {
    const err = new RefreshTokenInvalidError();
    expect(err.message).toBe('Invalid or expired refresh token');
  });

  it('has the class name as error name', () => {
    expect(new RefreshTokenInvalidError().name).toBe('RefreshTokenInvalidError');
  });
});

describe('RefreshTokenReusedError', () => {
  it('is an instance of UnauthorizedError and Error', () => {
    const err = new RefreshTokenReusedError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new RefreshTokenReusedError();
    expect(err.code).toBe('REFRESH_TOKEN_REUSED');
    expect(err.kind).toBe(ErrorKind.Unauthorized);
  });

  it('has a descriptive message', () => {
    const err = new RefreshTokenReusedError();
    expect(err.message).toBe('Refresh token reuse detected');
  });

  it('has the class name as error name', () => {
    expect(new RefreshTokenReusedError().name).toBe('RefreshTokenReusedError');
  });
});
