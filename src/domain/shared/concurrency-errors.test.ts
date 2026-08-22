import { describe, expect, it } from 'vitest';
import { StaleAggregateError } from './concurrency-errors';
import { ConflictError, ErrorKind } from '@/shared/errors';

describe('StaleAggregateError', () => {
  it('is a conflict so the error handler maps it to 409', () => {
    const error = new StaleAggregateError('User', 'user-1');

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.kind).toBe(ErrorKind.Conflict);
    expect(error.code).toBe('STALE_AGGREGATE');
  });

  it('names the aggregate and id without asserting a cause', () => {
    const error = new StaleAggregateError('User', 'user-1');

    expect(error.message).toBe('User user-1 is no longer at the expected version');
    expect(error.details).toEqual({ aggregateName: 'User', id: 'user-1' });
  });

  it('is operational so the handler logs it at info rather than error', () => {
    expect(new StaleAggregateError('User', 'user-1').isOperational).toBe(true);
  });
});
