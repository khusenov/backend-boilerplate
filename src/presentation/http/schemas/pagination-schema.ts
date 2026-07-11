import { z } from 'zod';

export function paginated<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  });
}
