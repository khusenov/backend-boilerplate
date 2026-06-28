import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/shared/errors';

export class RoleNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`Role with id ${id} not found`, { code: 'ROLE_NOT_FOUND' });
  }
}

export class RoleNameRequiredError extends ValidationError {
  constructor() {
    super('Role name is required', { code: 'ROLE_NAME_REQUIRED' });
  }
}

export class RoleNameTakenError extends ConflictError {
  constructor(name: string) {
    super(`Role name ${name} is already taken`, { code: 'ROLE_NAME_TAKEN' });
  }
}

export class UnknownPermissionError extends ValidationError {
  constructor(key: string) {
    super(`Unknown permission ${key}`, { code: 'UNKNOWN_PERMISSION' });
  }
}

export class RoleDeletedError extends ConflictError {
  constructor(id: string) {
    super(`Role with id ${id} is deleted`, { code: 'ROLE_DELETED' });
  }
}

export class SystemRoleProtectedError extends ForbiddenError {
  constructor(id: string) {
    super(`Role with id ${id} is a protected system role`, { code: 'ROLE_PROTECTED' });
  }
}
