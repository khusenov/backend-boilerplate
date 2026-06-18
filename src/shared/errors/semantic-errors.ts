import { AppError, type ErrorDetails, ErrorKind } from './app-error';

export interface SemanticErrorOptions {
  code?: string;
  details?: ErrorDetails;
  cause?: unknown;
}

export class ValidationError extends AppError {
  constructor(message: string, options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.Validation,
      code: options?.code ?? 'VALIDATION',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.NotFound,
      code: options?.code ?? 'NOT_FOUND',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.Conflict,
      code: options?.code ?? 'CONFLICT',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.Unauthorized,
      code: options?.code ?? 'UNAUTHORIZED',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.Forbidden,
      code: options?.code ?? 'FORBIDDEN',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
    });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal error', options?: SemanticErrorOptions) {
    super({
      kind: ErrorKind.Internal,
      code: options?.code ?? 'INTERNAL',
      message,
      ...(options?.details !== undefined && { details: options?.details }),
      ...(options?.cause !== undefined && { cause: options?.cause }),
      isOperational: false,
    });
  }
}
