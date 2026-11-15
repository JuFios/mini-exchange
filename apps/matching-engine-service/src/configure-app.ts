import { configureHttp } from './observability/http';
import { DatabaseExceptionFilter } from './database/database-exception.filter';
import { ReplicaIoAdapter } from './realtime/replica-io.adapter';
import { RateLimitFilter } from './security/rate-limits';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';

const reservedFields = new Set(Object.getOwnPropertyNames(Object.prototype));

class RequestValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (this.toValidate(metadata) && value && typeof value === 'object') {
      // Nest і class-transformer прибирають ці поля ще до перевірки whitelist.
      const extra = Object.keys(value).find((key) => reservedFields.has(key));
      if (extra) throw new BadRequestException([`Зайве поле ${extra}`]);
    }
    return super.transform(value, metadata);
  }

  override createExceptionFactory() {
    const createException = super.createExceptionFactory();
    return (errors: ValidationError[] = []) => {
      for (const { constraints, property } of errors) {
        if (constraints?.whitelistValidation) {
          constraints.whitelistValidation = `Зайве поле ${property}`;
        }
      }
      return createException(errors);
    };
  }
}

export function configureApp(app: INestApplication): void {
  const expected = createHash('sha256')
    .update(app.get(ConfigService).getOrThrow<string>('INGRESS_TOKEN'))
    .digest();
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const presented = request.headers['x-exchange-ingress'];
    delete request.headers['x-exchange-ingress'];
    if (
      typeof presented !== 'string' ||
      !timingSafeEqual(expected, createHash('sha256').update(presented).digest())
    ) {
      delete request.headers['x-forwarded-for'];
      delete request.headers['x-real-ip'];
      delete request.headers.forwarded;
    }
    next();
  });
  configureHttp(app, 'Matching Engine');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(
    new RequestValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new DatabaseExceptionFilter(app.getHttpAdapter()), new RateLimitFilter());
  app.useWebSocketAdapter(new ReplicaIoAdapter(app));
}
