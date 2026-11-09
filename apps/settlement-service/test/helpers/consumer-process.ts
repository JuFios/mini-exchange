import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { WalletPublisher } from '../../src/wallets/wallet-publisher';

// Дочірній процес зупиняється в потрібному вікні й чекає SIGKILL від тесту.
const [window] = process.argv.slice(2);
const park = (): Promise<never> => {
  process.send?.({ window });
  return new Promise(() => undefined);
};
if (window === 'before-ack') Redis.prototype.xack = park as never;
if (window === 'before-wallet-push') WalletPublisher.prototype.publish = park;

void NestFactory.createApplicationContext(AppModule, { logger: ['error'] }).catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
