import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { paginated } from './pagination-schema';

describe('paginated()', () => {
  const schema = paginated(z.object({ id: z.uuid() }));
  const base = { page: 1, pageSize: 10, total: 1, hasNext: false, hasPrev: false };

  it('validates a well-formed page envelope', () => {
    const page = { ...base, items: [{ id: '11111111-1111-4111-8111-111111111111' }] };
    expect(() => schema.parse(page)).not.toThrow();
  });

  it('strips unknown fields from items', () => {
    const page = {
      ...base,
      items: [{ id: '11111111-1111-4111-8111-111111111111', secret: 'x' }],
    };
    const parsed = schema.parse(page);
    expect(parsed.items[0]).not.toHaveProperty('secret');
  });
});
