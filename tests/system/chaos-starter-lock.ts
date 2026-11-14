import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { docker, request, until } from './helpers';

const [project, starterImage, fixedImage] = process.argv.slice(2);
const network = `${project}_default`;
const TTL_MS = 5000;
// Як `LEASE_RENEW_INTERVAL_MS` engine: власник поновлює lease, поки живий.
const RENEW_MS = 1500;
const redis = `${project}-redis-1`;

// Обидва образи запускають справжній RedisLockService зі свого dist.
const child = String.raw`
  const { once } = require('node:events');
  const { setTimeout: delay } = require('node:timers/promises');
  const { RedisLockService } = require('/app/dist/locks/redis-lock.service');
  const [mode, variant, key, ttl, renew] = process.argv.slice(1);
  const lock = new RedisLockService({
    getOrThrow: (name) => ({ REDIS_HOST: 'redis', REDIS_PORT: 6379, LEASE_TTL_MS: Number(ttl) })[name],
  });
  void (async () => {
    if (lock.client.status !== 'ready') await once(lock.client, 'ready');
    if (mode === 'owner') {
      if (!await lock.acquire(key, 'owner')) throw new Error('First owner failed to acquire');
      // У starter lease без TTL і без renew; виправлений поновлює його, як engine.
      const renewal = variant === 'fixed'
        ? setInterval(() => void lock.renew(key, 'owner').catch(() => undefined), Number(renew))
        : undefined;
      console.log('ready');
      await delay(90000);
      clearInterval(renewal);
    } else {
      const start = Date.now();
      let attempts = 0;
      const duration = variant === 'starter' ? 60000 : 20000;
      do {
        attempts++;
        if (await lock.acquire(key, 'contender')) {
          console.log(JSON.stringify({ acquiredAt: Date.now(), attempts }));
          return;
        }
        if (attempts === 1) console.log('polling');
        await delay(50);
      } while (Date.now() - start < duration);
      console.log(JSON.stringify({ acquiredAt: null, attempts, observedMs: Date.now() - start }));
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => lock.onModuleDestroy());
`;

async function lockScenario(image: string, variant: 'starter' | 'fixed') {
  const key = `system-test:lease:${randomUUID()}`;
  const owner = `${project}-${variant}-owner`;
  const contender = `${project}-${variant}-contender`;
  const args = [
    '--network',
    network,
    '--label',
    `exchange.system.baseline=${project}`,
    '--entrypoint',
    'node',
    '-e',
    'REDIS_HOST=redis',
  ];
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    owner,
    ...args,
    image,
    '-e',
    child,
    'owner',
    variant,
    key,
    String(TTL_MS),
    String(RENEW_MS),
  );
  try {
    await until(
      async () => docker('logs', owner),
      (logs) => logs.trim() === 'ready',
      5000,
    );
    const ttl = Number(docker('exec', redis, 'redis-cli', 'PTTL', key));
    if (variant === 'starter') assert.equal(ttl, -1);
    else {
      assert(ttl > 0 && ttl <= TTL_MS);
      // Живий власник тримає lease довше за TTL: передача після kill — наслідок kill, а не TTL.
      await new Promise((resolve) => setTimeout(resolve, TTL_MS + 1000));
      assert.equal(docker('exec', redis, 'redis-cli', 'GET', key), 'owner');
    }

    // Претендент уже опитує lock до kill: його старт не з'їдає вікно TTL.
    docker(
      'run',
      '-d',
      '--name',
      contender,
      ...args,
      image,
      '-e',
      child,
      'contender',
      variant,
      key,
      String(TTL_MS),
    );
    await until(
      async () => docker('logs', contender),
      (logs) => logs.includes('polling'),
      15000,
    );
    const failedAt = Date.now();
    docker('kill', '--signal', 'KILL', owner);
    docker('wait', contender);
    const { acquiredAt, attempts, observedMs } = JSON.parse(
      docker('logs', contender).trim().split('\n').at(-1)!,
    ) as { acquiredAt: number | null; attempts: number; observedMs?: number };
    if (variant === 'starter') {
      assert.equal(acquiredAt, null, 'Starter lease must remain orphaned');
      assert(observedMs && observedMs >= 60000 && attempts > 1);
      assert.equal(docker('exec', redis, 'redis-cli', 'TTL', key), '-1');
      console.log(`baseline=starter-lock attempts=${attempts} observedMs=${observedMs} ttl=-1`);
    } else {
      assert(acquiredAt !== null);
      const takeoverMs = acquiredAt - failedAt;
      // Поки власник живий, претендент не бере lease; після kill — не пізніше ніж за TTL від
      // останнього renew. Запас 1 с покриває `docker kill` і опитування раз на 50 мс.
      assert(
        takeoverMs > 0 && takeoverMs <= TTL_MS + 1000,
        `Fixed lock takeover took ${takeoverMs}ms`,
      );
      console.log(
        `baseline=fixed-lock attempts=${attempts} takeoverMs=${takeoverMs} ttlMs=${TTL_MS}`,
      );
    }
  } finally {
    try {
      docker('rm', '-f', contender);
    } catch {
      // Претендента ще не створено.
    }
    docker('exec', redis, 'redis-cli', 'DEL', key);
  }
}

async function starterBook() {
  const base = 'http://matching-engine-service:3001';
  const registration = await request(
    '/auth/register',
    'POST',
    undefined,
    { email: `${randomUUID()}@system.test`, password: 'system-user-password' },
    base,
  );
  assert.equal(registration.status, 201, await registration.clone().text());
  const { accessToken } = (await registration.json()) as { accessToken: string };
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      request(
        '/orders',
        'POST',
        accessToken,
        { instrument: 'ABC', side: 'buy', price: 99 + i / 100, quantity: 1 },
        base,
      ),
    ),
  );
  for (const response of responses) assert.equal(response.status, 201, await response.text());
  const own = await request('/orders', 'GET', accessToken, undefined, base);
  assert.equal(own.status, 200);
  assert.equal(((await own.json()) as unknown[]).length, 20);
  const depth = await request('/orders/book?instrument=ABC', 'GET', accessToken, undefined, base);
  assert.equal(depth.status, 200);
  const { bids, asks } = (await depth.json()) as { bids: unknown[]; asks: unknown[] };
  assert.equal(asks.length, 0);
  assert(bids.length > 0 && bids.length < 20, `Expected lost bids, saw ${bids.length}`);
  console.log(`baseline=starter-book accepted=20 persisted=20 bids=${bids.length}`);
}

async function main() {
  assert(
    project && starterImage && fixedImage,
    'Expected the isolated project and both engine images',
  );
  await starterBook();
  await lockScenario(starterImage, 'starter');
  await lockScenario(fixedImage, 'fixed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
