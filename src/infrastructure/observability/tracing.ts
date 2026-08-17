import { appIdentity } from '@/config/app-identity';
import { env } from '@/config/env';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

const DEPLOYMENT_ENVIRONMENT_ATTRIBUTE = 'deployment.environment.name';
const OTLP_TRACES_PATH = '/v1/traces';

const TRACING_REGISTRY_KEY = Symbol.for(appIdentity.tracingRegistryKey);

interface TracingRegistry {
  sdk: NodeSDK | undefined;
}

const globalScope = globalThis as Record<symbol, unknown>;
const registry: TracingRegistry = (globalScope[TRACING_REGISTRY_KEY] as
  TracingRegistry | undefined) ?? { sdk: undefined };
globalScope[TRACING_REGISTRY_KEY] = registry;

export function startTracing(): void {
  if (registry.sdk !== undefined || !env.OTEL_ENABLED || env.isTest) {
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: new URL(OTLP_TRACES_PATH, env.OTEL_EXPORTER_OTLP_ENDPOINT).toString(),
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: env.OTEL_SERVICE_VERSION,
      [DEPLOYMENT_ENVIRONMENT_ATTRIBUTE]: env.NODE_ENV,
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-pino': { enabled: false },
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  registry.sdk = sdk;
}

export async function shutdownTracing(): Promise<void> {
  if (registry.sdk === undefined) {
    return;
  }
  await registry.sdk.shutdown();
  registry.sdk = undefined;
}
