import { describe, expect, it } from 'vitest';
import { ListPermissions } from './list-permissions';
import { ALL_PERMISSIONS } from '@/domain/authorization/permission-catalogue';

describe('ListPermissions', () => {
  it('returns the catalogue grouped by category', () => {
    const result = new ListPermissions().execute();

    const categories = result.map((g) => g.category);
    expect(categories).toEqual(['users', 'roles']);

    const flatKeys = result.flatMap((g) => g.permissions.map((p) => p.key));
    expect(flatKeys.sort()).toEqual(ALL_PERMISSIONS.map((p) => p.key).sort());
  });

  it('groups every permission under exactly one category', () => {
    const result = new ListPermissions().execute();

    const total = result.reduce((sum, g) => sum + g.permissions.length, 0);
    expect(total).toBe(ALL_PERMISSIONS.length);
  });
});
