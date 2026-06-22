import { describe, expect, it } from 'vitest';
import {
  EmailAlreadyTakenError,
  UserDeletedError,
  UserInvalidNameError,
  UserNotFoundError,
} from './user-errors';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors';
import { ErrorKind } from '@/shared/errors/app-error';

describe('UserDeletedError', () => {
  it('is an instance of ConflictError and Error', () => {
    const err = new UserDeletedError('abc-123');
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new UserDeletedError('abc-123');
    expect(err.code).toBe('USER_DELETED');
    expect(err.kind).toBe(ErrorKind.Conflict);
  });

  it('includes the user id in the message', () => {
    const err = new UserDeletedError('abc-123');
    expect(err.message).toContain('abc-123');
  });

  it('has the class name as error name', () => {
    expect(new UserDeletedError('x').name).toBe('UserDeletedError');
  });
});

describe('UserInvalidNameError', () => {
  it('is an instance of ValidationError and Error', () => {
    const err = new UserInvalidNameError('firstName');
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new UserInvalidNameError('firstName');
    expect(err.code).toBe('USER_NAME_INVALID');
    expect(err.kind).toBe(ErrorKind.Validation);
  });

  it('includes the field name in the message', () => {
    const err = new UserInvalidNameError('lastName');
    expect(err.message).toContain('lastName');
  });

  it('has the class name as error name', () => {
    expect(new UserInvalidNameError('x').name).toBe('UserInvalidNameError');
  });
});

describe('EmailAlreadyTakenError', () => {
  it('is an instance of ConflictError and Error', () => {
    const err = new EmailAlreadyTakenError('user@example.com');
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new EmailAlreadyTakenError('user@example.com');
    expect(err.code).toBe('EMAIL_ALREADY_TAKEN');
    expect(err.kind).toBe(ErrorKind.Conflict);
  });

  it('includes the email in the message', () => {
    const err = new EmailAlreadyTakenError('user@example.com');
    expect(err.message).toContain('user@example.com');
  });

  it('has the class name as error name', () => {
    expect(new EmailAlreadyTakenError('x').name).toBe('EmailAlreadyTakenError');
  });
});

describe('UserNotFoundError', () => {
  it('is an instance of NotFoundError and Error', () => {
    const err = new UserNotFoundError('abc-123');
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has the correct code and kind', () => {
    const err = new UserNotFoundError('abc-123');
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.kind).toBe(ErrorKind.NotFound);
  });

  it('includes the user id in the message', () => {
    const err = new UserNotFoundError('abc-123');
    expect(err.message).toContain('abc-123');
  });

  it('has the class name as error name', () => {
    expect(new UserNotFoundError('x').name).toBe('UserNotFoundError');
  });
});
