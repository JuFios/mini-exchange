import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(
    `CONFIG_READY ${JSON.stringify({ url: await app.getUrl(), chaos: app.get(ConfigService).getOrThrow('CHAOS_ENABLED') })}`,
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
