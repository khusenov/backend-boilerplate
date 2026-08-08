export const MIN_SECRET_LENGTH = 32;
const MIN_DASHBOARD_PASSWORD_LENGTH = 16;

const PRODUCTION_SECRET_KEYS = [
  'COOKIE_SECRET',
  'JWT_ACCESS_SECRET',
  'VERIFICATION_CODE_SECRET',
] as const;

export interface SecretPolicyInput {
  readonly isProduction: boolean;
  readonly COOKIE_SECRET: string;
  readonly JWT_ACCESS_SECRET: string;
  readonly BULL_BOARD_ENABLED: boolean;
  readonly BULL_BOARD_PASSWORD: string;
  readonly VERIFICATION_CODE_SECRET: string;
}

export function assertProductionSecrets(env: SecretPolicyInput): void {
  if (!env.isProduction) {
    return;
  }

  const weakSecrets: string[] = PRODUCTION_SECRET_KEYS.filter(
    (key) => env[key].length < MIN_SECRET_LENGTH,
  );
  if (env.BULL_BOARD_ENABLED && env.BULL_BOARD_PASSWORD.length < MIN_DASHBOARD_PASSWORD_LENGTH) {
    weakSecrets.push('BULL_BOARD_PASSWORD');
  }

  if (weakSecrets.length === 0) {
    return;
  }

  const offendingKeys = weakSecrets.join(', ');
  throw new Error(
    `Insecure production configuration: ${offendingKeys} must be at least ` +
      `${MIN_SECRET_LENGTH} characters. Generate a strong value with: openssl rand -base64 48`,
  );
}
