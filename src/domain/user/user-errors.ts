import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors';

export class UserDeletedError extends ConflictError {
  constructor(id: string) {
    super(`User with id ${id} is deleted`, { code: 'USER_DELETED' });
  }
}

export class UserInvalidNameError extends ValidationError {
  constructor(field: string) {
    super(`${field} is invalid`, { code: 'USER_NAME_INVALID' });
  }
}

export class EmailAlreadyTakenError extends ConflictError {
  constructor(email: string) {
    super(`Email ${email} is already taken`, { code: 'EMAIL_ALREADY_TAKEN' });
  }
}

export class UserNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`User with id ${id} not found`, { code: 'USER_NOT_FOUND' });
  }
}
