export interface UserGrants {
  systemRoleKeys: string[];
  permissions: string[];
}

export interface GrantsReader {
  grantsFor(userId: string): Promise<UserGrants>;
}
