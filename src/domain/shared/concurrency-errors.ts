import { ConflictError } from '@/shared/errors';

export class StaleAggregateError extends ConflictError {
  constructor(aggregateName: string, id: string) {
    super(`${aggregateName} ${id} is no longer at the expected version`, {
      code: 'STALE_AGGREGATE',
      details: { aggregateName, id },
    });
  }
}
