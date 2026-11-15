import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from '../../src/auth/auth.service';
import type { Request } from 'express';
import Redis from 'ioredis';
import fc from 'fast-check';
import { RateLimits } from '../../src/security/rate-limits';
import { connect, disconnected, emitWithAck } from '../helpers/websocket';
import { engineApp } from './engine-app';

const api = engineApp();
const from = (address: string) => ({ 'x-forwarded-for': address });

it('shares a 10-order window between both replicas and leaves a second user unaffected', async () => {
  const options = { ORDER_RATE_LIMIT: 10, ORDER_RATE_TTL_MS: 60_000 };
  await api.restart(options);
  const replica = await api.build({ ...options, INSTANCE_ID: 'peer' });
  try {
    const [first, second] = await Promise.all([api.register(), api.register()]);
    const urls = [api.url(), await replica.getUrl()];
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fetch(urls[index % 2] + '/orders', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + first, 'content-type': 'application/json' },
          body: JSON.stringify({ instrument: 'ABC', side: 'sell', price: '100', quantity: '1' }),
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    );
    expect(responses.filter(({ ok }) => ok)).toHaveLength(10);
    const denied = responses.filter(({ status }) => status === 429);
    expect(denied).toHaveLength(20);
    for (const response of denied)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await api.submit(second)).ok).toBe(true);
  } finally {
    await replica.close();
  }
}, 30_000);

it('limits authentication by client IP', async () => {
  await api.restart({ AUTH_RATE_LIMIT: 10 });
  const login = (ip: string) =>
    api.request(
      '/auth/login',
      'POST',
      undefined,
      { email: `${randomUUID()}@example.test`, password: 'incorrect-password' },
      from(ip),
    );
  for (let index = 0; index < 11; index++) {
    const response = await login('198.51.100.10');
    if (index < 10) expect(response.status).toBe(401);
    else {
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
  }
  expect((await login('198.51.100.11')).status).toBe(401);
});

describe('failed logins per email', () => {
  const password = 'owner-account-password';
  const login = (ip: string, email: string, attempt = 'incorrect-password') =>
    api.request('/auth/login', 'POST', undefined, { email, password: attempt }, from(ip));
  const owner = async () => {
    const email = `${randomUUID()}@example.test`;
    const response = await api.request('/auth/register', 'POST', undefined, { email, password });
    expect(response.status).toBe(201);
    return email;
  };

  it("10 wrong passwords from another address do not block the owner's login", async () => {
    await api.restart({ AUTH_RATE_LIMIT: 1000, LOGIN_EMAIL_RATE_LIMIT: 10 });
    const email = await owner();
    for (let index = 0; index < 10; index++) {
      const variant = index % 2 === 0 ? email : email.toUpperCase();
      expect((await login('192.0.2.1', variant)).status).toBe(401);
    }
    const blocked = await login('192.0.2.1', email);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Правильний пароль з тієї ж адреси теж чекає: блок діє до перевірки пароля.
    expect((await login('192.0.2.1', email, password)).status).toBe(429);

    expect((await login('192.0.2.2', email, password)).status).toBe(201);
    expect((await login('192.0.2.2', email)).status).toBe(401);
  });

  it('does not count successful logins', async () => {
    await api.restart({ AUTH_RATE_LIMIT: 1000, LOGIN_EMAIL_RATE_LIMIT: 3 });
    const email = await owner();
    for (let index = 0; index < 6; index++)
      expect((await login('192.0.2.3', email, password)).status).toBe(201);
    for (let index = 0; index < 3; index++)
      expect((await login('192.0.2.3', email)).status).toBe(401);
    expect((await login('192.0.2.3', email)).status).toBe(429);
  });

  it('caps failed logins for one email across addresses', async () => {
    await api.restart({
      AUTH_RATE_LIMIT: 1000,
      LOGIN_EMAIL_RATE_LIMIT: 10,
      LOGIN_EMAIL_TOTAL_RATE_LIMIT: 20,
    });
    const email = await owner();
    for (let index = 0; index < 20; index++)
      expect((await login(`203.0.113.${index + 1}`, email)).status).toBe(401);
    const blocked = await login('203.0.113.100', email);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Після загальної межі чекає й власник. Кількість адрес залежить від початку вікон пар.
    expect((await login('203.0.113.101', email, password)).status).toBe(429);
    expect((await login('203.0.113.101', `${randomUUID()}@example.test`)).status).toBe(401);
  });

  it('does not count successful logins against the total for the email', async () => {
    await api.restart({ AUTH_RATE_LIMIT: 1000, LOGIN_EMAIL_TOTAL_RATE_LIMIT: 3 });
    const email = await owner();
    for (let index = 0; index < 6; index++)
      expect((await login(`192.0.2.${10 + index}`, email, password)).status).toBe(201);
    for (let index = 0; index < 3; index++)
      expect((await login(`192.0.2.${20 + index}`, email)).status).toBe(401);
    expect((await login('192.0.2.30', email)).status).toBe(429);
  });

  // Відхилені запити не рахуються: інакше повтори з тієї ж адреси тримали б блок безстроково.
  it('lets the owner in when the window of the first failure ends despite refused retries', async () => {
    const window = 2000;
    await api.restart({
      AUTH_RATE_LIMIT: 1000,
      LOGIN_EMAIL_RATE_LIMIT: 3,
      LOGIN_EMAIL_TOTAL_RATE_LIMIT: 1000,
      LOGIN_EMAIL_RATE_TTL_MS: window,
    });
    const email = await owner();
    const started = Date.now();
    expect((await login('192.0.2.40', email)).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let index = 0; index < 2; index++)
      expect((await login('192.0.2.40', email)).status).toBe(401);
    // Власник повторює правильний пароль кожні 100 мс, поки не ввійде.
    let status = 429;
    while (status === 429 && Date.now() - started < 2 * window + 1000) {
      status = (await login('192.0.2.40', email, password)).status;
      if (status === 429) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe(201);
    expect(Date.now() - started).toBeLessThan(window + 500);
  });

  it('keeps refused attempts on the total out of the address counter and the window', async () => {
    const window = 2000;
    await api.restart({
      AUTH_RATE_LIMIT: 1000,
      LOGIN_EMAIL_RATE_LIMIT: 3,
      LOGIN_EMAIL_TOTAL_RATE_LIMIT: 4,
      LOGIN_EMAIL_RATE_TTL_MS: window,
    });
    const email = await owner();
    const started = Date.now();
    for (let index = 0; index < 4; index++)
      expect((await login(`192.0.2.${50 + index}`, email)).status).toBe(401);
    // Вікно пари для нової адреси відкрилося б пізніше за загальне й ще тривало б під час перевірки.
    await new Promise((resolve) => setTimeout(resolve, 600));
    while (Date.now() - started < window - 500) {
      expect((await login('192.0.2.60', email)).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, started + window + 200 - Date.now()));
    // Адреса, якій відмовила загальна межа, не витратила свою: три невдачі ще дозволені.
    for (let index = 0; index < 3; index++)
      expect((await login('192.0.2.60', email)).status).toBe(401);
    expect((await login('192.0.2.61', email, password)).status).toBe(201);
  });

  it('counts concurrent wrong passwords before bcrypt finishes', async () => {
    await api.restart({ AUTH_RATE_LIMIT: 1000, LOGIN_EMAIL_RATE_LIMIT: 5 });
    const email = await owner();
    const statuses = await Promise.all(
      Array.from({ length: 20 }, async () => (await login('192.0.2.4', email)).status),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  });

  it.each([
    { scope: 'address', pairLimit: 1, totalLimit: 1000, unavailable: false },
    { scope: 'total', pairLimit: 1000, totalLimit: 1, unavailable: false },
    { scope: 'address', pairLimit: 1, totalLimit: 1000, unavailable: true },
    { scope: 'total', pairLimit: 1000, totalLimit: 1, unavailable: true },
  ] as const)(
    'preserves the next $scope window after a delayed login (unavailable: $unavailable)',
    async ({ scope, pairLimit, totalLimit, unavailable }) => {
      const window = 2000;
      const options = {
        AUTH_RATE_LIMIT: 1000,
        LOGIN_EMAIL_RATE_LIMIT: pairLimit,
        LOGIN_EMAIL_TOTAL_RATE_LIMIT: totalLimit,
        LOGIN_EMAIL_RATE_TTL_MS: window,
      };
      await api.restart(options);
      const replica = await api.build({ ...options, INSTANCE_ID: 'peer' });
      const email = await owner();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const auth = api.app().get(AuthService);
      const original = auth.login.bind(auth);
      const delayed = jest.spyOn(auth, 'login').mockImplementationOnce(async (dto) => {
        const result = await original(dto);
        entered();
        await gate;
        if (unavailable) throw new ServiceUnavailableException();
        return result;
      });
      const pending = login('192.0.2.70', email, password);
      const replicaUrl = await replica.getUrl();
      const attempt = (ip: string) =>
        fetch(`${replicaUrl}/auth/login`, {
          method: 'POST',
          headers: { ...from(ip), 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'incorrect-password' }),
          signal: AbortSignal.timeout(5000),
        });
      try {
        await Promise.race([
          waiting,
          pending.then(() => {
            throw new Error('Login completed before the session barrier');
          }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, window + 100));
        expect((await attempt('192.0.2.70')).status).toBe(401);
        release();
        expect((await pending).status).toBe(unavailable ? 503 : 201);
        expect((await attempt('192.0.2.70')).status).toBe(429);
        expect((await attempt('192.0.2.71')).status).toBe(scope === 'total' ? 429 : 401);
      } finally {
        release();
        await pending.catch(() => undefined);
        delayed.mockRestore();
        await replica.close();
      }
    },
  );

  it.each(['address', 'total'] as const)(
    'preserves failed logins for any refund order across %s windows',
    async (scope) => {
      const limit = 7;
      await api.restart({
        LOGIN_EMAIL_RATE_LIMIT: scope === 'address' ? limit : 1000,
        LOGIN_EMAIL_TOTAL_RATE_LIMIT: scope === 'total' ? limit : 1000,
        LOGIN_EMAIL_RATE_TTL_MS: 60_000,
      });
      const limits = api.app().get(RateLimits);
      const redis = new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD,
        connectTimeout: 1000,
        commandTimeout: 1000,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 3 }),
            fc.integer({ min: 1, max: 3 }),
            fc.integer({ min: 1, max: 3 }),
            fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }),
            async (oldHeld, currentHeld, failed, order) => {
              const email = `${randomUUID()}@example.test`;
              const take = (ip = '192.0.2.80') => limits.loginAttempt(email, { ip } as Request);
              const old = [];
              for (let index = 0; index < oldHeld; index++) old.push(await take());
              // Redis завершує старі вікна примусово: генератор не чекає по хвилині на історію.
              const keys = await redis.keys(
                `exchange:limit:${api.database().options.database}:login_email*`,
              );
              expect(keys.length).toBeGreaterThan(0);
              await Promise.all(keys.map((key) => redis.pexpireat(key, 1)));
              await new Promise((resolve) => setTimeout(resolve, 5));
              const current = [];
              for (let index = 0; index < currentHeld; index++) current.push(await take());
              for (let index = 0; index < failed; index++) await take();
              const refunds = [...old, ...current];
              for (const index of order) await refunds[index]?.();
              // Після повернення всіх успішних входів лишається рівно failed невдач.
              for (let index = failed; index < limit; index++) await take();
              await expect(take()).rejects.toMatchObject({ status: 429 });
              if (scope === 'total')
                await expect(take('192.0.2.81')).rejects.toMatchObject({ status: 429 });
              else await expect(take('192.0.2.81')).resolves.toEqual(expect.any(Function));
            },
          ),
          { numRuns: 20, seed: 20261115 },
        );
      } finally {
        redis.disconnect();
      }
    },
  );
});

it('rejects the 121st public read from the same IP and accepts another IP', async () => {
  await api.restart({ PUBLIC_RATE_LIMIT: 120 });
  const read = (ip: string) =>
    api.request('/instruments/ABC/book', 'GET', undefined, undefined, from(ip));
  for (let index = 0; index < 121; index++) {
    expect((await read('198.51.100.20')).status).toBe(index < 120 ? 200 : 429);
  }
  expect((await read('198.51.100.21')).status).toBe(200);
});

it('rejects the 21st market subscription and disconnects on a frame over 16 KiB', async () => {
  await api.restart({ WS_SUBSCRIBE_RATE_LIMIT: 20 });
  const socket = await connect(api.url(), '/market');
  try {
    for (let index = 0; index < 20; index++) {
      expect(await emitWithAck(socket, 'book.subscribe', { instrument: 'ABC' })).toMatchObject({
        ok: true,
      });
    }
    expect(await emitWithAck(socket, 'book.subscribe', { instrument: 'ABC' })).toEqual({
      ok: false,
      error: 'RATE_LIMITED',
    });
    const closed = disconnected(socket, 3000);
    socket.emit('book.subscribe', { instrument: 'ABC', padding: 'a'.repeat(16_385) });
    await closed;
  } finally {
    socket.disconnect();
  }
});
