import { describe, expect, it } from 'vitest';
import { SystemClock } from './system-clock';

describe('SystemClock', () => {
  it('returns the current wall-clock time', () => {
    const before = Date.now();
    const reading = new SystemClock().now().getTime();
    const after = Date.now();

    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  it('does not hand out a shared mutable instance', () => {
    const clock = new SystemClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});
