export interface UserRoleRepository {
  listRoleIdsForUser(userId: string): Promise<string[]>;

  assign(userId: string, roleId: string, grantedAt: Date): Promise<void>;

  revoke(userId: string, roleId: string): Promise<void>;
}
