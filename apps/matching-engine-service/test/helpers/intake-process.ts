import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';

async function start() {
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  process.stdout.write(`INTAKE_READY ${await app.getUrl()}\n`);
}

void start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
