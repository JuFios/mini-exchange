import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './configure-app';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`matching-engine-service (${config.getOrThrow<string>('INSTANCE_ID')}) listening on ${port}`);
}
bootstrap();
