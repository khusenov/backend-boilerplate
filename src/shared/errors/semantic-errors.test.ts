import { describe, expect, it } from 'vitest';
import { AppError, ErrorKind } from './app-error';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './semantic-errors';

describe('ValidationError', () => {
  it('is an instance of AppError', () => {
    expect(new ValidationError('bad input')).toBeInstanceOf(AppError);
  });

  it('sets kind to Validation', () => {
    expect(new ValidationError('bad input').kind).toBe(ErrorKind.Validation);
  });

  it('defaults code to VALIDATION', () => {
    expect(new ValidationError('bad input').code).toBe('VALIDATION');
  });

  it('accepts a custom code', () => {
    expect(new ValidationError('bad input', { code: 'INVALID_EMAIL' }).code).toBe('INVALID_EMAIL');
  });

  it('sets the message', () => {
    expect(new ValidationError('bad input').message).toBe('bad input');
  });

  it('propagates details', () => {
    const err = new ValidationError('bad input', { details: { field: 'email' } });

    expect(err.details).toEqual({ field: 'email' });
  });

  it('propagates cause', () => {
    const cause = new Error('root');
    const err = new ValidationError('bad input', { cause });

    expect(err.cause).toBe(cause);
  });

  it('is operational', () => {
    expect(new ValidationError('bad input').isOperational).toBe(true);
  });
});

describe('NotFoundError', () => {
  it('is an instance of AppError', () => {
    expect(new NotFoundError('not found')).toBeInstanceOf(AppError);
  });

  it('sets kind to NotFound', () => {
    expect(new NotFoundError('not found').kind).toBe(ErrorKind.NotFound);
  });

  it('defaults code to NOT_FOUND', () => {
    expect(new NotFoundError('not found').code).toBe('NOT_FOUND');
  });

  it('accepts a custom code', () => {
    expect(new NotFoundError('not found', { code: 'USER_NOT_FOUND' }).code).toBe('USER_NOT_FOUND');
  });

  it('is operational', () => {
    expect(new NotFoundError('not found').isOperational).toBe(true);
  });
});

describe('ConflictError', () => {
  it('is an instance of AppError', () => {
    expect(new ConflictError('conflict')).toBeInstanceOf(AppError);
  });

  it('sets kind to Conflict', () => {
    expect(new ConflictError('conflict').kind).toBe(ErrorKind.Conflict);
  });

  it('defaults code to CONFLICT', () => {
    expect(new ConflictError('conflict').code).toBe('CONFLICT');
  });

  it('accepts a custom code', () => {
    expect(new ConflictError('conflict', { code: 'EMAIL_TAKEN' }).code).toBe('EMAIL_TAKEN');
  });

  it('is operational', () => {
    expect(new ConflictError('conflict').isOperational).toBe(true);
  });
});

describe('UnauthorizedError', () => {
  it('is an instance of AppError', () => {
    expect(new UnauthorizedError()).toBeInstanceOf(AppError);
  });

  it('sets kind to Unauthorized', () => {
    expect(new UnauthorizedError().kind).toBe(ErrorKind.Unauthorized);
  });

  it('defaults code to UNAUTHORIZED', () => {
    expect(new UnauthorizedError().code).toBe('UNAUTHORIZED');
  });

  it('defaults message to Unauthorized', () => {
    expect(new UnauthorizedError().message).toBe('Unauthorized');
  });

  it('accepts a custom message', () => {
    expect(new UnauthorizedError('token expired').message).toBe('token expired');
  });

  it('accepts a custom code', () => {
    expect(new UnauthorizedError('denied', { code: 'TOKEN_EXPIRED' }).code).toBe('TOKEN_EXPIRED');
  });

  it('is operational', () => {
    expect(new UnauthorizedError().isOperational).toBe(true);
  });
});

describe('ForbiddenError', () => {
  it('is an instance of AppError', () => {
    expect(new ForbiddenError()).toBeInstanceOf(AppError);
  });

  it('sets kind to Forbidden', () => {
    expect(new ForbiddenError().kind).toBe(ErrorKind.Forbidden);
  });

  it('defaults code to FORBIDDEN', () => {
    expect(new ForbiddenError().code).toBe('FORBIDDEN');
  });

  it('defaults message to Forbidden', () => {
    expect(new ForbiddenError().message).toBe('Forbidden');
  });

  it('accepts a custom message', () => {
    expect(new ForbiddenError('no access').message).toBe('no access');
  });

  it('is operational', () => {
    expect(new ForbiddenError().isOperational).toBe(true);
  });
});

describe('InternalError', () => {
  it('is an instance of AppError', () => {
    expect(new InternalError()).toBeInstanceOf(AppError);
  });

  it('sets kind to Internal', () => {
    expect(new InternalError().kind).toBe(ErrorKind.Internal);
  });

  it('defaults code to INTERNAL', () => {
    expect(new InternalError().code).toBe('INTERNAL');
  });

  it('defaults message to Internal error', () => {
    expect(new InternalError().message).toBe('Internal error');
  });

  it('accepts a custom message', () => {
    expect(new InternalError('db crashed').message).toBe('db crashed');
  });

  it('is NOT operational', () => {
    expect(new InternalError().isOperational).toBe(false);
  });

  it('propagates cause', () => {
    const cause = new Error('db error');
    const err = new InternalError('Internal error', { cause });

    expect(err.cause).toBe(cause);
  });
});
