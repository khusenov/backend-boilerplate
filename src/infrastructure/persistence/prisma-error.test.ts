import { describe, expect, it } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { mapPrismaError } from './prisma-error';
import { ConflictError, NotFoundError, InternalError } from '@/shared/errors';

function makePrismaError(code: string): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError('prisma error', {
    code,
    clientVersion: '6.0.0',
  });
}

describe('mapPrismaError', () => {
  it('throws ConflictError with UNIQUE_VIOLATION code for P2002', () => {
    expect(() => mapPrismaError(makePrismaError('P2002'))).toThrow(ConflictError);

    try {
      mapPrismaError(makePrismaError('P2002'));
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).code).toBe('UNIQUE_VIOLATION');
    }
  });

  it('throws NotFoundError with RECORD_NOT_FOUND code for P2025', () => {
    expect(() => mapPrismaError(makePrismaError('P2025'))).toThrow(NotFoundError);

    try {
      mapPrismaError(makePrismaError('P2025'));
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as NotFoundError).code).toBe('RECORD_NOT_FOUND');
    }
  });

  it('wraps P2002 as cause on the thrown ConflictError', () => {
    const original = makePrismaError('P2002');
    try {
      mapPrismaError(original);
    } catch (e) {
      expect((e as ConflictError).cause).toBe(original);
    }
  });

  it('wraps P2025 as cause on the thrown NotFoundError', () => {
    const original = makePrismaError('P2025');
    try {
      mapPrismaError(original);
    } catch (e) {
      expect((e as NotFoundError).cause).toBe(original);
    }
  });

  it('throws InternalError for an unrecognised Prisma error code', () => {
    expect(() => mapPrismaError(makePrismaError('P1001'))).toThrow(InternalError);
  });

  it('throws InternalError for a plain Error', () => {
    expect(() => mapPrismaError(new Error('unexpected'))).toThrow(InternalError);
  });

  it('throws InternalError for a non-Error value', () => {
    expect(() => mapPrismaError('string error')).toThrow(InternalError);
    expect(() => mapPrismaError(null)).toThrow(InternalError);
  });

  it('marks InternalError as non-operational', () => {
    try {
      mapPrismaError(new Error('db down'));
    } catch (e) {
      expect((e as InternalError).isOperational).toBe(false);
    }
  });
});
