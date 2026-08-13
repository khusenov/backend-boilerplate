import { describe, expect, it } from 'vitest';
import { ensurePermission, ensureSelfOrPermission, ensureSystemActor } from './access-policy';
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  SystemActorRequiredError,
} from './access-policy-errors';
import { ANONYMOUS_ACTOR, createUserActor, type Actor } from './actor';
import { createSystemActor } from './system-actor';
import { PERMISSIONS, SUPERADMIN_ROLE_KEY } from './permission-catalogue';

const SYSTEM_ACTOR = createSystemActor('test');

function user(
  overrides: Partial<{ userId: string; systemRoleKeys: string[]; permissions: string[] }> = {},
) {
  return createUserActor({
    userId: overrides.userId ?? 'user-1',
    systemRoleKeys: overrides.systemRoleKeys ?? [],
    permissions: overrides.permissions ?? [],
  });
}

describe('ensurePermission', () => {
  it('throws AuthenticationRequiredError for an anonymous actor', () => {
    expect(() => {
      ensurePermission(ANONYMOUS_ACTOR, PERMISSIONS.UsersRead.key);
    }).toThrow(AuthenticationRequiredError);
  });

  it('resolves for a user holding the exact permission', () => {
    expect(() => {
      ensurePermission(
        user({ permissions: [PERMISSIONS.UsersRead.key] }),
        PERMISSIONS.UsersRead.key,
      );
    }).not.toThrow();
  });

  it('throws PermissionDeniedError for a user holding a different permission', () => {
    expect(() => {
      ensurePermission(
        user({ permissions: [PERMISSIONS.UsersRead.key] }),
        PERMISSIONS.UsersDelete.key,
      );
    }).toThrow(PermissionDeniedError);
  });

  it('reports the requested key as details.required', () => {
    expect(() => {
      ensurePermission(user(), PERMISSIONS.UsersDelete.key);
    }).toThrow(expect.objectContaining({ details: { required: PERMISSIONS.UsersDelete.key } }));
  });

  it('denies rather than crashing for a legacy token degraded to an empty permission list', () => {
    expect(() => {
      ensurePermission(user({ permissions: [] }), PERMISSIONS.UsersRead.key);
    }).toThrow(PermissionDeniedError);
  });

  it('resolves for a superadmin holding no permissions', () => {
    expect(() => {
      ensurePermission(
        user({ systemRoleKeys: [SUPERADMIN_ROLE_KEY] }),
        PERMISSIONS.UsersDelete.key,
      );
    }).not.toThrow();
  });

  it('throws for a user holding a non-superadmin system role and no permissions', () => {
    expect(() => {
      ensurePermission(user({ systemRoleKeys: ['auditor'] }), PERMISSIONS.UsersDelete.key);
    }).toThrow(PermissionDeniedError);
  });

  it('resolves for a system actor holding no permissions', () => {
    expect(() => {
      ensurePermission(SYSTEM_ACTOR, PERMISSIONS.UsersDelete.key);
    }).not.toThrow();
  });

  it('throws PermissionDeniedError for an unrecognized actor kind', () => {
    expect(() => {
      ensurePermission({ kind: 'ghost' } as unknown as Actor, PERMISSIONS.UsersRead.key);
    }).toThrow(PermissionDeniedError);
  });
});

describe('ensureSelfOrPermission', () => {
  it('resolves for the target user themselves, holding no permissions', () => {
    expect(() => {
      ensureSelfOrPermission(user({ userId: 'user-1' }), 'user-1', PERMISSIONS.UsersUpdate.key);
    }).not.toThrow();
  });

  it('throws PermissionDeniedError for another user without the permission', () => {
    expect(() => {
      ensureSelfOrPermission(user({ userId: 'user-1' }), 'user-2', PERMISSIONS.UsersUpdate.key);
    }).toThrow(PermissionDeniedError);
  });

  it('resolves for another user when the permission is held', () => {
    expect(() => {
      ensureSelfOrPermission(
        user({ userId: 'user-1', permissions: [PERMISSIONS.UsersUpdate.key] }),
        'user-2',
        PERMISSIONS.UsersUpdate.key,
      );
    }).not.toThrow();
  });

  it('resolves for a superadmin acting on another user', () => {
    expect(() => {
      ensureSelfOrPermission(
        user({ userId: 'user-1', systemRoleKeys: [SUPERADMIN_ROLE_KEY] }),
        'user-2',
        PERMISSIONS.UsersUpdate.key,
      );
    }).not.toThrow();
  });

  it('throws AuthenticationRequiredError for an anonymous actor', () => {
    expect(() => {
      ensureSelfOrPermission(ANONYMOUS_ACTOR, 'user-1', PERMISSIONS.UsersUpdate.key);
    }).toThrow(AuthenticationRequiredError);
  });

  it('resolves for a system actor, which has no user id to compare', () => {
    expect(() => {
      ensureSelfOrPermission(SYSTEM_ACTOR, 'user-1', PERMISSIONS.UsersUpdate.key);
    }).not.toThrow();
  });
});

describe('ensureSystemActor', () => {
  it('resolves for a system actor', () => {
    expect(() => {
      ensureSystemActor(SYSTEM_ACTOR);
    }).not.toThrow();
  });

  it('throws SystemActorRequiredError for a user actor', () => {
    expect(() => {
      ensureSystemActor(user({ systemRoleKeys: [SUPERADMIN_ROLE_KEY] }));
    }).toThrow(SystemActorRequiredError);
  });

  it('throws SystemActorRequiredError for an anonymous actor', () => {
    expect(() => {
      ensureSystemActor(ANONYMOUS_ACTOR);
    }).toThrow(SystemActorRequiredError);
  });
});
