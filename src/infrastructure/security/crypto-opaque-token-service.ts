import { randomBytes, createHash } from 'node:crypto';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';

export class CryptoOpaqueTokenService implements OpaqueTokenService {
  generate(): string {
    return randomBytes(32).toString('base64url'); // 256 bits of entropy
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex'); // 64 hex chars
  }
}
