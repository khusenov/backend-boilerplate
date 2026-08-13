import type { Actor, SystemActor } from './actor';
import { SUPERADMIN_ROLE_KEY, type PermissionKey } from './permission-catalogue';
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  SystemActorRequiredError,
} from './access-policy-errors';

// Typed `never` so a new Actor arm is a compile error here rather than a silent grant:
// a void-returning switch may legally fall off its end, which would allow the new kind.
function denyUnrecognizedActor(actor: never, permission: PermissionKey): never {
  throw new PermissionDeniedError(permission);
}

export function ensurePermission(actor: Actor, permission: PermissionKey): void {
  switch (actor.kind) {
    case 'system':
      return;
    case 'anonymous':
      throw new AuthenticationRequiredError();
    case 'user':
      if (actor.systemRoleKeys.includes(SUPERADMIN_ROLE_KEY)) return;
      if (!actor.permissions.includes(permission)) throw new PermissionDeniedError(permission);
      return;
    default:
      return denyUnrecognizedActor(actor, permission);
  }
}

export function ensureSelfOrPermission(
  actor: Actor,
  targetUserId: string,
  permission: PermissionKey,
): void {
  if (actor.kind === 'user' && actor.userId === targetUserId) return;
  ensurePermission(actor, permission);
}

export function ensureSystemActor(actor: Actor): asserts actor is SystemActor {
  if (actor.kind !== 'system') throw new SystemActorRequiredError();
}
