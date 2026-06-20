import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await verify(hash, plain);
    } catch {
      return false;
    }
  }
}
