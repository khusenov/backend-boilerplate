import {
  ANONYMOUS_ACTOR,
  createUserActor,
  type AnonymousActor,
  type UserActor,
} from '@/domain/authorization/actor';
import type { AccessTokenPayload } from '@/application/shared/ports/access-token-service';

export type RequestActor = UserActor | AnonymousActor;

export function toRequestActor(
  user: Pick<AccessTokenPayload, 'sub' | 'systemRoleKeys' | 'permissions'> | undefined,
): RequestActor {
  if (!user) return ANONYMOUS_ACTOR;
  return createUserActor({
    userId: user.sub,
    systemRoleKeys: user.systemRoleKeys,
    permissions: user.permissions,
  });
}
