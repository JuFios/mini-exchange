import { NestFactory } from '@nestjs/core';
import { configureApp } from './configure-app';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`matching-engine-service (${process.env.INSTANCE_ID ?? 'engine'}) listening on ${port}`);
}
bootstrap();
