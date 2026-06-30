/**
 * Verifies that a critical downstream dependency is reachable.
 *
 * Resolves when the dependency is healthy; rejects when it is not — the
 * readiness probe maps a rejection to a 503 response.
 */
export interface HealthCheck {
  check(): Promise<void>;
}
