export const ErrorKind = {
  Validation: 'VALIDATION',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  Internal: 'INTERNAL',
} as const;

export type ErrorKindType = (typeof ErrorKind)[keyof typeof ErrorKind];

export type ErrorDetails = Record<string, unknown>;

export interface SerializedError {
  code: string;
  message: string;
  details?: ErrorDetails;
}

export interface AppErrorOptions {
  kind: ErrorKindType;
  code: string;
  message: string;
  details?: ErrorDetails;
  cause?: unknown;
  isOperational?: boolean;
}

export abstract class AppError extends Error {
  public readonly kind: ErrorKindType;
  public readonly code: string;
  public readonly details?: ErrorDetails;
  public readonly isOperational: boolean;
  public readonly timestamp: Date;

  protected constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = new.target.name;

    this.kind = options.kind;
    this.code = options.code;
    this.isOperational = options.isOperational ?? true;
    this.timestamp = new Date();
    if (options.details !== undefined) this.details = options.details;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }

  public toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}
