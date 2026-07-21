import type { RefreshToken } from './refresh-token-entity';

export interface RefreshTokenRepository {
  create(token: RefreshToken): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<RefreshToken | null>;

  update(token: RefreshToken): Promise<void>;

  revokeFamily(familyId: string, revokedAt: Date): Promise<void>;

  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;

  deleteExpired(cutoff: Date): Promise<number>;
}
