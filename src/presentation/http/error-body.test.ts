import { describe, expect, it } from 'vitest';
import { ForbiddenError, InternalError } from '@/shared/errors';
import { INTERNAL_FALLBACK_MESSAGE, publicErrorBody } from '@/presentation/http/error-body';

describe('publicErrorBody', () => {
  it('round-trips an operational error, details included', () => {
    const error = new ForbiddenError('access denied', {
      code: 'FORBIDDEN',
      details: { required: ['roles:write'] },
    });

    expect(publicErrorBody(error)).toEqual({
      code: 'FORBIDDEN',
      message: 'access denied',
      details: { required: ['roles:write'] },
    });
  });

  it('redacts the details and the developer message of a non-operational error', () => {
    const error = new InternalError('codec for user.created is malformed', {
      code: 'DOMAIN_EVENT_CODEC_MALFORMED',
      details: { eventName: 'user.created', reason: 'no decoder' },
    });

    expect(publicErrorBody(error)).toEqual({
      code: 'DOMAIN_EVENT_CODEC_MALFORMED',
      message: INTERNAL_FALLBACK_MESSAGE,
    });
  });
});
