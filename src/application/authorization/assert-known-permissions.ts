import { isKnownPermissionKey } from '@/domain/authorization/permission-catalogue';
import { UnknownPermissionError } from '@/domain/authorization/role-errors';

export function assertKnownPermissions(keys: readonly string[]): void {
  for (const key of keys) {
    if (!isKnownPermissionKey(key)) throw new UnknownPermissionError(key);
  }
}
