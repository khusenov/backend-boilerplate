import type { HealthCheck } from '@/application/shared/ports/health-check';

export class CompositeHealthCheck implements HealthCheck {
  private readonly checks: readonly HealthCheck[];

  constructor(checks: readonly HealthCheck[]) {
    if (checks.length === 0) {
      throw new Error('CompositeHealthCheck requires at least one health check');
    }
    this.checks = checks;
  }

  async check(): Promise<void> {
    await Promise.all(this.checks.map((healthCheck) => healthCheck.check()));
  }
}
