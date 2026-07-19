export const MIN_SECRET_LENGTH = 32;

const PRODUCTION_SECRET_KEYS = ['COOKIE_SECRET', 'JWT_ACCESS_SECRET'] as const;

interface SecretPolicyInput {
  readonly isProduction: boolean;
  readonly COOKIE_SECRET: string;
  readonly JWT_ACCESS_SECRET: string;
}

export function assertProductionSecrets(env: SecretPolicyInput): void {
  if (!env.isProduction) {
    return;
  }

  const weakSecrets = PRODUCTION_SECRET_KEYS.filter((key) => env[key].length < MIN_SECRET_LENGTH);

  if (weakSecrets.length === 0) {
    return;
  }

  const offendingKeys = weakSecrets.join(', ');
  throw new Error(
    `Insecure production configuration: ${offendingKeys} must be at least ` +
      `${MIN_SECRET_LENGTH} characters. Generate a strong value with: openssl rand -base64 48`,
  );
}
