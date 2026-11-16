import { EngineOutboxClient } from '../../src/consumer/engine-outbox.client';
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
EngineOutboxClient.prototype.event = async (envelope) => ({ position: '1', envelope: envelope! });
EngineOutboxClient.prototype.page = async () => [];
if (window === 'before-ack') Redis.prototype.xack = park as never;
if (window === 'before-wallet-push') WalletPublisher.prototype.publish = park;

void NestFactory.createApplicationContext(AppModule, { logger: ['error'] }).catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
