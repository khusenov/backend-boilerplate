import { Entity, type EntityProps } from '@/domain/shared/entity';

interface RefreshTokenProps extends EntityProps {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

interface RefreshTokenCreateParams {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export class RefreshToken extends Entity<RefreshTokenProps> {
  private constructor(props: RefreshTokenProps) {
    super(props);
  }

  get userId(): string {
    return this.props.userId;
  }

  get familyId(): string {
    return this.props.familyId;
  }

  get tokenHash(): string {
    return this.props.tokenHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get usedAt(): Date | null {
    return this.props.usedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get isUsed(): boolean {
    return this.props.usedAt !== null;
  }

  get isRevoked(): boolean {
    return this.props.revokedAt !== null;
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  isActive(now: Date): boolean {
    return !this.isUsed && !this.isRevoked && !this.isExpired(now);
  }

  static create(params: RefreshTokenCreateParams, now: Date): RefreshToken {
    return new RefreshToken({
      ...params,
      usedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static hydrate(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }

  markUsed(now: Date): void {
    if (this.isUsed) return;
    this.props.usedAt = now;
    this.touch(now);
  }

  revoke(now: Date): void {
    if (this.isRevoked) return;
    this.props.revokedAt = now;
    this.touch(now);
  }
}
