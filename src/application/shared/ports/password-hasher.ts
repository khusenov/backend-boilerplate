export interface PasswordHasher {
  hash(plain: string): Promise<string>;
}
