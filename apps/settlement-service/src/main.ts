import { TracingShutdown } from './tracing';
import { Module } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { configureApp } from './configure-app';
import { AppModule } from './app.module';

@Module({ imports: [AppModule], providers: [TracingShutdown] })
class RuntimeModule {}

async function bootstrap() {
  const app = await NestFactory.create(RuntimeModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`settlement-service listening on ${port}`);
}
bootstrap();
