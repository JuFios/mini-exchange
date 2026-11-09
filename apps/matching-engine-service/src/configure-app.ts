import { DatabaseExceptionFilter } from './database/database-exception.filter';
import { ReplicaIoAdapter } from './realtime/replica-io.adapter';
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
  app.useGlobalPipes(
    new RequestValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new DatabaseExceptionFilter(app.getHttpAdapter()));
  app.enableCors();
  app.useWebSocketAdapter(new ReplicaIoAdapter(app));
}
