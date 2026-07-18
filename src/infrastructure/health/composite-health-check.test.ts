import { describe, expect, it, vi } from 'vitest';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import { CompositeHealthCheck } from './composite-health-check';

function makeCheck() {
  return {
    check: vi.fn<HealthCheck['check']>().mockResolvedValue(undefined),
  } satisfies HealthCheck;
}

describe('CompositeHealthCheck', () => {
  it('rejects construction when given no checks', () => {
    expect(() => new CompositeHealthCheck([])).toThrow('at least one');
  });

  describe('check', () => {
    it('resolves when every member check resolves', async () => {
      const sut = new CompositeHealthCheck([makeCheck(), makeCheck()]);

      await expect(sut.check()).resolves.toBeUndefined();
    });

    it('invokes every member check', async () => {
      const first = makeCheck();
      const second = makeCheck();
      const sut = new CompositeHealthCheck([first, second]);

      await sut.check();

      expect(first.check).toHaveBeenCalledOnce();
      expect(second.check).toHaveBeenCalledOnce();
    });

    it('rejects with the failure when any member check rejects', async () => {
      const failing: HealthCheck = {
        check: vi.fn<HealthCheck['check']>().mockRejectedValue(new Error('redis down')),
      };
      const sut = new CompositeHealthCheck([makeCheck(), failing]);

      await expect(sut.check()).rejects.toThrow('redis down');
    });
  });
});
