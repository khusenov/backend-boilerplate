import { asClass, asFunction } from 'awilix';
import type { Redis } from 'ioredis';
import { env } from '@/config/env';
import type { AccessTokenService } from '@/application/shared/ports/access-token-service';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import { Argon2PasswordHasher } from '@/infrastructure/security/argon2-password-hasher';
import { JoseAccessTokenService } from '@/infrastructure/security/jose-access-token-service';
import { CryptoOpaqueTokenService } from '@/infrastructure/security/crypto-opaque-token-service';
import { CryptoVerificationCodeService } from '@/infrastructure/security/crypto-verification-code-service';
import { createRateLimitRedis } from '@/infrastructure/security/rate-limit-redis';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    passwordHasher: PasswordHasher;
    accessTokenService: AccessTokenService;
    opaqueTokenService: OpaqueTokenService;
    verificationCodeService: VerificationCodeService;
    rateLimitRedis: Redis;
  }
}

export const securityRegistrations = {
  passwordHasher: asClass(Argon2PasswordHasher).singleton(),
  accessTokenService: asClass(JoseAccessTokenService).singleton(),
  opaqueTokenService: asClass(CryptoOpaqueTokenService).singleton(),
  verificationCodeService: asFunction(
    () =>
      new CryptoVerificationCodeService({ verificationCodeSecret: env.VERIFICATION_CODE_SECRET }),
  ).singleton(),
  rateLimitRedis: asFunction(() => createRateLimitRedis({ redisUrl: env.REDIS_URL }))
    .singleton()
    .disposer((connection) => connection.disconnect()),
} satisfies RegistrationMap;
