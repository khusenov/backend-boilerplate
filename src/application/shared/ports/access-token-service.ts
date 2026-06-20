export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
}

export interface AccessTokenService {
  sign(payload: AccessTokenPayload): Promise<string>;

  verify(token: string): Promise<AccessTokenPayload>;
}
