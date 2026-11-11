import type { MessageKey } from '@/shared/i18n/message-key';

export const enMessages = {
  'error.VALIDATION': 'The request contains invalid data.',
  'error.BAD_REQUEST': 'The request could not be processed.',
  'error.ROUTE_NOT_FOUND': 'The requested route was not found.',
  'error.NOT_FOUND': 'The requested resource was not found.',
  'error.CONFLICT': 'The request conflicts with the current state of the resource.',
  'error.UNAUTHORIZED': 'Authentication is required.',
  'error.FORBIDDEN': 'You do not have permission to perform this action.',
  'error.INTERNAL': 'Something went wrong. Please try again later.',
  'error.RATE_LIMITED': 'Too many requests. Please slow down and try again shortly.',

  'error.USER_NOT_FOUND': 'No user was found for the identifier {id}.',
  'error.USER_DELETED': 'This user account has been deleted.',
  'error.USER_NAME_INVALID': 'The name provided is not valid.',
  'error.EMAIL_ALREADY_TAKEN': 'That email address is already in use.',
  'error.INVALID_EMAIL': 'That email address is not valid.',

  'error.INVALID_CREDENTIALS': 'The email address or password is incorrect.',
  'error.REFRESH_TOKEN_INVALID': 'Your session is no longer valid. Please sign in again.',
  'error.REFRESH_TOKEN_REUSED':
    'Your session was ended for security reasons. Please sign in again.',
  'error.MISSING_ACCESS_TOKEN': 'An access token is required.',
  'error.INVALID_ACCESS_TOKEN': 'The access token is not valid.',
  'error.AUTHENTICATION_REQUIRED': 'You must be signed in to perform this action.',
  'error.SYSTEM_ACTOR_REQUIRED': 'This action can only be performed by the system.',

  'error.ROLE_NOT_FOUND': 'No role was found for the identifier {id}.',
  'error.ROLE_NAME_REQUIRED': 'A role name is required.',
  'error.ROLE_NAME_TAKEN': 'That role name is already in use.',
  'error.ROLE_DELETED': 'This role has been deleted.',
  'error.ROLE_PROTECTED': 'System roles cannot be modified.',
  'error.UNKNOWN_PERMISSION': 'One or more of the permissions requested are not recognised.',

  'error.PASSWORD_RESET_TOKEN_INVALID': 'This password reset link is not valid.',
  'error.PASSWORD_RESET_TOKEN_EXPIRED': 'This password reset link has expired.',
  'error.VERIFICATION_CODE_INVALID': 'That verification code is not correct.',
  'error.VERIFICATION_CODE_EXPIRED': 'That verification code has expired.',
  'error.TOO_MANY_VERIFICATION_ATTEMPTS': 'Too many attempts. Please request a new code.',

  'error.STALE_AGGREGATE': 'This record was changed by someone else. Please reload and try again.',
  'error.UNIQUE_VIOLATION': 'A record with those values already exists.',
  'error.RECORD_NOT_FOUND': 'The requested record was not found.',

  'error.IDEMPOTENCY_KEY_INVALID': 'The idempotency key is not valid.',
  'error.IDEMPOTENCY_KEY_MISMATCH':
    'This idempotency key was already used with a different request.',
  'error.IDEMPOTENCY_KEY_IN_PROGRESS':
    'A request with this idempotency key is still being processed.',

  'error.DOMAIN_EVENT_UNKNOWN': 'Something went wrong. Please try again later.',
  'error.DOMAIN_EVENT_CODEC_DUPLICATE': 'Something went wrong. Please try again later.',
  'error.DOMAIN_EVENT_CODEC_MALFORMED': 'Something went wrong. Please try again later.',
  'error.DOMAIN_EVENT_ENCODE_FAILED': 'Something went wrong. Please try again later.',
  'error.DOMAIN_EVENT_DECODE_FAILED': 'Something went wrong. Please try again later.',
  'error.DOMAIN_EVENT_VERSION_MISMATCH': 'Something went wrong. Please try again later.',

  'validation.invalid_type': 'This value has an unexpected type.',
  'validation.invalid_format': 'This value is not in the expected format.',
  'validation.invalid_value': 'This value is not one of the allowed options.',
  'validation.not_multiple_of': 'This value must be a multiple of {divisor}.',
  'validation.unrecognized_keys': 'This object contains properties that are not recognised.',
  'validation.invalid_union': 'This value does not match any of the accepted shapes.',
  'validation.invalid_key': 'This object contains a key that is not valid.',
  'validation.invalid_element': 'This collection contains an element that is not valid.',
  'validation.custom': 'This value is not valid.',
  'validation.unknown': 'This value is not valid.',
  'validation.too_small':
    '{origin, select, string {Must be at least {minimum, plural, one {# character} other {# characters}} long.} array {Must contain at least {minimum, plural, one {# item} other {# items}}.} other {Must not be less than {minimum}.}}',
  'validation.too_big':
    '{origin, select, string {Must be at most {maximum, plural, one {# character} other {# characters}} long.} array {Must contain at most {maximum, plural, one {# item} other {# items}}.} other {Must not be greater than {maximum}.}}',
} satisfies Record<MessageKey, string>;
