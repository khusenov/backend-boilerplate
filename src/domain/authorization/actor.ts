declare const systemActorBrand: unique symbol;

export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
  readonly systemRoleKeys: readonly string[];
  readonly permissions: readonly string[];
}

export interface SystemActor {
  readonly kind: 'system';
  readonly name: string;
  readonly [systemActorBrand]: true;
}

export interface AnonymousActor {
  readonly kind: 'anonymous';
}

export type Actor = UserActor | SystemActor | AnonymousActor;

export const ANONYMOUS_ACTOR: AnonymousActor = Object.freeze({ kind: 'anonymous' });

export interface UserActorProps {
  userId: string;
  systemRoleKeys: readonly string[];
  permissions: readonly string[];
}

export function createUserActor({
  userId,
  systemRoleKeys,
  permissions,
}: UserActorProps): UserActor {
  // Copy before freezing: the caller's arrays stay mutable and aliased otherwise,
  // so the grant list backing every authorization decision could change underfoot.
  return Object.freeze({
    kind: 'user',
    userId,
    systemRoleKeys: Object.freeze([...systemRoleKeys]),
    permissions: Object.freeze([...permissions]),
  });
}
