import { TracingShutdown } from './tracing';
import { Module } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './configure-app';
import { AppModule } from './app.module';

@Module({ imports: [AppModule], providers: [TracingShutdown] })
class RuntimeModule {}

async function bootstrap() {
  const app = await NestFactory.create(RuntimeModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `matching-engine-service (${config.getOrThrow<string>('INSTANCE_ID')}) listening on ${port}`,
  );
}
bootstrap();
