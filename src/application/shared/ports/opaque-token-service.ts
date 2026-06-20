export interface OpaqueTokenService {
  generate(): string;

  hash(raw: string): string;
}
