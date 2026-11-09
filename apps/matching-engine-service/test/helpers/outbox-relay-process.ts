import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { validateEnv } from '../../src/config/env.validation';
import { engineDataSourceOptions } from '../../src/data-source';
import { OutboxRelay } from '../../src/outbox/outbox-relay.service';

const [eventId, window] = process.argv.slice(2);
const append = Redis.prototype.eval;
let resume: (() => void) | undefined;
process.on('message', (message) => {
  if (message === 'resume') resume?.();
});
const park = (): Promise<never> => {
  process.send?.({ eventId, window });
  return new Promise(() => undefined);
};
Redis.prototype.eval = async function (this: Redis, ...args: unknown[]) {
  const eventIdField = args.indexOf('eventId');
  const matches = eventIdField !== -1 && args[eventIdField + 1] === eventId;
  if (matches && window === 'before-xadd') await park();
  if (matches && window === 'pause-before-xadd') {
    await new Promise<void>((resolve) => {
      resume = resolve;
      process.send?.({ eventId, window });
    });
  }
  const id = await Reflect.apply(append, this, args);
  if (matches && window === 'after-xadd') await park();
  if (matches && window === 'pause-before-xadd') process.send?.({ eventId, id });
  return id;
} as Redis['eval'];

async function main() {
  const config = validateEnv(process.env);
  const source = await new DataSource(engineDataSourceOptions(config)).initialize();
  new OutboxRelay(source, new ConfigService(config)).onApplicationBootstrap();
}

void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exit(1);
});
