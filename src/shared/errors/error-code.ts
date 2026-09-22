import { ErrorKind } from './app-error';

export const ErrorCode = {
  ...ErrorKind,
  BadRequest: 'BAD_REQUEST',
  RouteNotFound: 'ROUTE_NOT_FOUND',
  RateLimited: 'RATE_LIMITED',

  UserNotFound: 'USER_NOT_FOUND',
  UserDeleted: 'USER_DELETED',
  UserNameInvalid: 'USER_NAME_INVALID',
  EmailAlreadyTaken: 'EMAIL_ALREADY_TAKEN',
  InvalidEmail: 'INVALID_EMAIL',

  InvalidCredentials: 'INVALID_CREDENTIALS',
  RefreshTokenInvalid: 'REFRESH_TOKEN_INVALID',
  RefreshTokenReused: 'REFRESH_TOKEN_REUSED',
  MissingAccessToken: 'MISSING_ACCESS_TOKEN',
  InvalidAccessToken: 'INVALID_ACCESS_TOKEN',
  AuthenticationRequired: 'AUTHENTICATION_REQUIRED',
  SystemActorRequired: 'SYSTEM_ACTOR_REQUIRED',

  RoleNotFound: 'ROLE_NOT_FOUND',
  RoleNameRequired: 'ROLE_NAME_REQUIRED',
  RoleNameTaken: 'ROLE_NAME_TAKEN',
  RoleDeleted: 'ROLE_DELETED',
  RoleProtected: 'ROLE_PROTECTED',
  UnknownPermission: 'UNKNOWN_PERMISSION',

  PasswordResetTokenInvalid: 'PASSWORD_RESET_TOKEN_INVALID',
  PasswordResetTokenExpired: 'PASSWORD_RESET_TOKEN_EXPIRED',
  VerificationCodeInvalid: 'VERIFICATION_CODE_INVALID',
  VerificationCodeExpired: 'VERIFICATION_CODE_EXPIRED',
  TooManyVerificationAttempts: 'TOO_MANY_VERIFICATION_ATTEMPTS',

  StaleAggregate: 'STALE_AGGREGATE',
  UniqueViolation: 'UNIQUE_VIOLATION',
  RecordNotFound: 'RECORD_NOT_FOUND',

  IdempotencyKeyInvalid: 'IDEMPOTENCY_KEY_INVALID',
  IdempotencyKeyMismatch: 'IDEMPOTENCY_KEY_MISMATCH',
  IdempotencyKeyInProgress: 'IDEMPOTENCY_KEY_IN_PROGRESS',

  DomainEventUnknown: 'DOMAIN_EVENT_UNKNOWN',
  DomainEventCodecDuplicate: 'DOMAIN_EVENT_CODEC_DUPLICATE',
  DomainEventCodecMalformed: 'DOMAIN_EVENT_CODEC_MALFORMED',
  DomainEventEncodeFailed: 'DOMAIN_EVENT_ENCODE_FAILED',
  DomainEventDecodeFailed: 'DOMAIN_EVENT_DECODE_FAILED',
  DomainEventVersionMismatch: 'DOMAIN_EVENT_VERSION_MISMATCH',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_CODE_VALUES: readonly string[] = Object.values(ErrorCode);

export function isErrorCode(value: string): value is ErrorCodeType {
  return ERROR_CODE_VALUES.includes(value);
}
