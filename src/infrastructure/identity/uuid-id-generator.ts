import { v7 as uuidv7 } from 'uuid';
import type { IdGenerator } from '@/application/shared/ports/id-generator';

export class UuidIdGenerator implements IdGenerator {
  generate(): string {
    return uuidv7();
  }
}
