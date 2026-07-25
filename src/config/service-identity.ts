export interface ServiceIdentity {
  service: string;
  environment: string;
  version: string;
}

interface ServiceIdentityConfig {
  OTEL_SERVICE_NAME: string;
  NODE_ENV: string;
  OTEL_SERVICE_VERSION: string;
}

export function toServiceIdentity(config: ServiceIdentityConfig): ServiceIdentity {
  return {
    service: config.OTEL_SERVICE_NAME,
    environment: config.NODE_ENV,
    version: config.OTEL_SERVICE_VERSION,
  };
}
