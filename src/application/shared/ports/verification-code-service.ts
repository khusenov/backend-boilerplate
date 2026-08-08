export interface VerificationCodeService {
  generate(): string;

  hash(code: string): string;
}
