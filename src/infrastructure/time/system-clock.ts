import type { Clock } from '@/application/shared/ports/clock';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
