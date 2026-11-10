import { existsSync } from 'node:fs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

if (existsSync('.env')) process.loadEnvFile();
process.env.OTEL_METRICS_EXPORTER ??= 'none';
process.env.OTEL_LOGS_EXPORTER ??= 'none';

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'matching-engine-service',
  // Локальний контекст і trace ID потрібні навіть без зовнішнього колектора.
  ...(process.env.OTEL_TRACES_EXPORTER === 'otlp'
    ? { traceExporter: new OTLPTraceExporter() }
    : {
        spanProcessors: [
          {
            onStart() {},
            onEnd() {},
            async forceFlush() {},
            async shutdown() {},
          },
        ],
      }),
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation(),
    new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    new UndiciInstrumentation(),
  ],
});
sdk.start();

export const shutdownTracing = () => sdk.shutdown();
