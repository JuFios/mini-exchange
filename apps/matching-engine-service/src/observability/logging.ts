import { ConfigService } from '@nestjs/config';
import { trace } from '@opentelemetry/api';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';

export const LoggingModule = LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    pinoHttp: {
      level: config.getOrThrow('LOG_LEVEL'),
      autoLogging: {
        ignore: (request) => ['/health', '/ready', '/metrics'].includes(request.url ?? ''),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-internal-token"]',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.refreshToken',
          '*.password',
          '*.refreshToken',
          '*.accessToken',
          '*.token',
        ],
        censor: '[Redacted]',
      },
      serializers: {
        req(request) {
          const url = String(request.url).split('?')[0];
          const raw = request.raw as Request;
          const body = /^\/auth\//i.test(url)
            ? { password: raw.body?.password, refreshToken: raw.body?.refreshToken }
            : undefined;
          return { ...request, url, body };
        },
      },
      mixin() {
        const span = trace.getActiveSpan()?.spanContext();
        return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
      },
    },
  }),
});
