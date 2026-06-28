export interface PermissionDef {
  key: string;
  name: string;
  category: string;
}

export const PERMISSIONS = {
  UsersRead: { key: 'users.read', name: 'View users', category: 'users' },
  UsersCreate: { key: 'users.create', name: 'Create users', category: 'users' },
  UsersUpdate: { key: 'users.update', name: 'Update users', category: 'users' },
  UsersDelete: { key: 'users.delete', name: 'Delete users', category: 'users' },
  RolesRead: { key: 'roles.read', name: 'View roles', category: 'roles' },
  RolesCreate: { key: 'roles.create', name: 'Create roles', category: 'roles' },
  RolesUpdate: { key: 'roles.update', name: 'Update roles', category: 'roles' },
  RolesDelete: { key: 'roles.delete', name: 'Delete roles', category: 'roles' },
  RolesAssign: { key: 'roles.assign', name: 'Assign roles to users', category: 'roles' },
} as const satisfies Record<string, PermissionDef>;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]['key'];

export const ALL_PERMISSIONS: readonly PermissionDef[] = Object.values(PERMISSIONS);

const PERMISSION_KEYS: ReadonlySet<string> = new Set(ALL_PERMISSIONS.map((p) => p.key));

export function isKnownPermissionKey(key: string): key is PermissionKey {
  return PERMISSION_KEYS.has(key);
}

export const SUPERADMIN_ROLE_KEY = 'super-admin';
