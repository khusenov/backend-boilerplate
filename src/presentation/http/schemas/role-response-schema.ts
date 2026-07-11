import { z } from 'zod';

import { timestamp } from './timestamp-schema';
import { paginated } from './pagination-schema';

/**
 * The public shape of a role on the wire. Mirrors `RoleDto`
 * (`src/application/authorization/role-dto.ts`). Any field not listed here is
 * stripped by the serializer, so internal state cannot leak.
 *
 * `key` and `description` are `string | null` in the DTO, so both are
 * `.nullable()` here — a plain `z.string()` would make the fail-closed
 * serializer reject a legitimate `null` and turn a 200 into a 500.
 */
export const roleResponse = z.object({
  id: z.uuid(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** A paginated list of roles, using the shared `Page<T>` envelope. */
export const paginatedRoles = paginated(roleResponse);
