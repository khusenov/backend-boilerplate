import { ConflictError, InternalError, NotFoundError } from '@/shared/errors';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

export function mapPrismaError(error: unknown): never {
  if (error instanceof PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictError('Unique constraint violated', {
        code: 'UNIQUE_VIOLATION',
        cause: error,
      });
    }

    if (error.code === 'P2025') {
      throw new NotFoundError('Record not found', {
        code: 'RECORD_NOT_FOUND',
        cause: error,
      });
    }
  }

  throw new InternalError('Database operation failed', { cause: error });
}
