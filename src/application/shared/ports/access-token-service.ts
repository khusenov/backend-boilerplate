export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  systemRoleKeys: string[];
  permissions: string[];
}

export interface AccessTokenService {
  sign(payload: AccessTokenPayload, now: Date): Promise<string>;

  verify(token: string): Promise<AccessTokenPayload>;
}
