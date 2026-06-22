import { describe, expect, it } from 'vitest';
import { AppError, ErrorKind, type AppErrorOptions } from './app-error';

class ConcreteError extends AppError {
  constructor(options: AppErrorOptions) {
    super(options);
  }
}

const makeError = (overrides: Partial<AppErrorOptions> = {}) =>
  new ConcreteError({
    kind: ErrorKind.Validation,
    code: 'TEST_ERROR',
    message: 'test message',
    ...overrides,
  });

describe('ErrorKind', () => {
  it('exposes all expected kind constants', () => {
    expect(ErrorKind.Validation).toBe('VALIDATION');
    expect(ErrorKind.NotFound).toBe('NOT_FOUND');
    expect(ErrorKind.Conflict).toBe('CONFLICT');
    expect(ErrorKind.Unauthorized).toBe('UNAUTHORIZED');
    expect(ErrorKind.Forbidden).toBe('FORBIDDEN');
    expect(ErrorKind.Internal).toBe('INTERNAL');
  });
});

describe('AppError', () => {
  it('is an instance of Error', () => {
    expect(makeError()).toBeInstanceOf(Error);
  });

  it('sets name to the concrete subclass name', () => {
    expect(makeError().name).toBe('ConcreteError');
  });

  it('sets kind, code, and message from options', () => {
    const err = makeError({ kind: ErrorKind.NotFound, code: 'MY_CODE', message: 'my message' });

    expect(err.kind).toBe(ErrorKind.NotFound);
    expect(err.code).toBe('MY_CODE');
    expect(err.message).toBe('my message');
  });

  it('defaults isOperational to true', () => {
    expect(makeError().isOperational).toBe(true);
  });

  it('respects isOperational: false', () => {
    expect(makeError({ isOperational: false }).isOperational).toBe(false);
  });

  it('sets details when provided', () => {
    const err = makeError({ details: { field: 'email' } });

    expect(err.details).toEqual({ field: 'email' });
  });

  it('leaves details undefined when not provided', () => {
    expect(makeError().details).toBeUndefined();
  });

  it('sets a timestamp close to the current time', () => {
    const before = new Date();
    const err = makeError();
    const after = new Date();

    expect(err.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(err.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('preserves the cause when provided', () => {
    const cause = new Error('root cause');
    const err = makeError({ cause });

    expect(err.cause).toBe(cause);
  });

  it('leaves cause undefined when not provided', () => {
    expect(makeError().cause).toBeUndefined();
  });

  describe('toJSON', () => {
    it('returns code and message', () => {
      const err = makeError({ code: 'MY_CODE', message: 'my message' });

      expect(err.toJSON()).toEqual({ code: 'MY_CODE', message: 'my message' });
    });

    it('includes details when present', () => {
      const err = makeError({ details: { field: 'email' } });

      expect(err.toJSON()).toEqual({
        code: 'TEST_ERROR',
        message: 'test message',
        details: { field: 'email' },
      });
    });

    it('omits details key when absent', () => {
      const json = makeError().toJSON();

      expect(json).not.toHaveProperty('details');
    });
  });
});
