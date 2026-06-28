import { SignJWT, jwtVerify } from 'jose';
import type {
  AccessTokenService,
  AccessTokenPayload,
} from '@/application/shared/ports/access-token-service';
import { UnauthorizedError } from '@/shared/errors';
import type { Env } from '@/config/env';

interface Deps {
  env: Env;
}

export class JoseAccessTokenService implements AccessTokenService {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor({ env }: Deps) {
    this.secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.issuer = env.JWT_ISSUER;
    this.audience = env.JWT_AUDIENCE;
    this.ttlSeconds = env.ACCESS_TOKEN_TTL;
  }

  async sign(payload: AccessTokenPayload): Promise<string> {
    return new SignJWT({
      email: payload.email,
      systemRoleKeys: payload.systemRoleKeys,
      permissions: payload.permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.secret);
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      });
      return {
        sub: payload.sub!,
        email: payload.email as string,
        systemRoleKeys: (payload.systemRoleKeys as string[] | undefined) ?? [],
        permissions: (payload.permissions as string[] | undefined) ?? [],
      };
    } catch (err) {
      throw new UnauthorizedError('Invalid or expired access token', {
        code: 'INVALID_ACCESS_TOKEN',
        cause: err,
      });
    }
  }
}
