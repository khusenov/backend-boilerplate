import { ForbiddenError, UnauthorizedError } from '@/shared/errors';
import type { PermissionKey } from './permission-catalogue';

export class AuthenticationRequiredError extends UnauthorizedError {
  constructor() {
    super('Authentication required', { code: 'AUTHENTICATION_REQUIRED' });
  }
}

export class PermissionDeniedError extends ForbiddenError {
  constructor(required: PermissionKey) {
    super('Insufficient permissions', { code: 'FORBIDDEN', details: { required } });
  }
}

export class SystemActorRequiredError extends ForbiddenError {
  constructor() {
    super('This operation requires a trusted system actor', { code: 'SYSTEM_ACTOR_REQUIRED' });
  }
}
