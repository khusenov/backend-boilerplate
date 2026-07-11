import { z } from 'zod';

/**
 * The permission catalogue on the wire. Mirrors `PermissionGroupDto[]`
 * (`src/application/authorization/permission-dto.ts`): an array of category
 * groups, each holding its `{ key, name }` items. There is no pagination and
 * no timestamps here, so this schema reuses neither `paginated` nor `timestamp`.
 */
export const permissionItemResponse = z.object({
  key: z.string(),
  name: z.string(),
});

export const permissionGroupResponse = z.object({
  category: z.string(),
  permissions: z.array(permissionItemResponse),
});

export const permissionsResponse = z.array(permissionGroupResponse);
