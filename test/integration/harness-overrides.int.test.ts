import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './support/harness';

describe('harness cradle overrides', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({
      healthCheck: { check: () => Promise.reject(new Error('dependency down')) },
    });
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('applies an override for a dependency resolved during buildApp', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  });
});
