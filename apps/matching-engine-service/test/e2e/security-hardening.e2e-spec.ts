import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { engineApp } from './engine-app';
import fc from 'fast-check';
import { Redis, ReplyError } from 'ioredis';
import { engineMetrics } from '../../src/observability/metrics';
import { RateLimits } from '../../src/security/rate-limits';

const api = engineApp();
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

function limiterRedis() {
  const limits = api.app().get(RateLimits) as unknown as {
    storage: { redis: Redis & { stream: Socket } };
  };
  return limits.storage.redis;
}

it('shares the write quota across tokens, addresses and replicas without blocking another user', async () => {
  const options = { ORDER_WRITE_RATE_LIMIT: 3, ORDER_WRITE_RATE_TTL_MS: 60_000 };
  await api.restart(options);
  const replica = await api.build(options);
  try {
    const first = await api.register();
    const email = `${randomUUID()}@example.test`;
    const password = 'strong-test-password';
    const registered = await api.request('/auth/register', 'POST', undefined, { email, password });
    const { accessToken, refreshToken } = await registered.json();
    const rotated = await api.request('/auth/refresh', 'POST', undefined, { refreshToken });
    const nextToken = (await rotated.json()).accessToken;
    const urls = [api.url(), await replica.getUrl()];
    for (let index = 0; index < 6; index++) {
      const response = await fetch(
        urls[index % 2] + '/orders/' + randomUUID() + '?instrument=ABC',
        {
          method: 'DELETE',
          headers: {
            authorization: 'Bearer ' + (index % 2 ? nextToken : accessToken),
            'x-exchange-ingress': process.env.INGRESS_TOKEN!,
            'x-forwarded-for': `192.0.2.${index + 1}`,
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(response.status).toBe(index < 3 ? 404 : 429);
      if (index >= 3) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect((await api.submit(first)).status).toBe(201);
  } finally {
    await replica.close();
  }
});

it('keeps cancellation and completed replay available when the write limiter is unavailable', async () => {
  const token = await api.register();
  const key = randomUUID();
  const body = { instrument: 'ABC', side: 'sell', price: '100', quantity: '1' };
  const first = await api.request('/orders', 'POST', token, body, { 'idempotency-key': key });
  const { order } = await first.json();
  api.app().get(RateLimits).onModuleDestroy();
  expect(
    (await api.request('/orders', 'POST', token, body, { 'idempotency-key': key })).status,
  ).toBe(200);
  expect((await api.request(`/orders/${order.id}?instrument=ABC`, 'DELETE', token)).status).toBe(
    200,
  );
  expect((await api.submit(token)).status).toBe(503);
});

it('keeps cancellation and completed replay available after a stalled write limiter times out', async () => {
  const token = await api.register();
  const key = randomUUID();
  const body = { instrument: 'ABC', side: 'sell', price: '100', quantity: '1' };
  const submit = () =>
    api.request('/orders', 'POST', token, body, { 'idempotency-key': key }, 3000);
  const initial = await submit();
  expect(initial.status).toBe(201);
  const { order } = await initial.json();
  const cancel = () => api.request(`/orders/${order.id}`, 'DELETE', token, undefined, {}, 3000);

  // Затримуємо запис у сокет лише клієнта лімітів. Його власний commandTimeout має
  // спрацювати без відповіді Redis, поки клієнти lease та outbox продовжують роботу.
  const socket = limiterRedis().stream;
  socket.cork();
  try {
    for (const [request, status] of [
      [submit, 200],
      [cancel, 200],
    ] as const) {
      const started = performance.now();
      expect((await request()).status).toBe(status);
      expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    }
  } finally {
    socket.uncork();
  }
});

it('refuses writes when Redis answers the write limiter with an error and counts each bypass', async () => {
  await api.restart();
  const token = await api.register();
  const { order } = await (await api.submit(token)).json();
  const redis = limiterRedis();
  const bypassed = async () =>
    (await engineMetrics.getSingleMetricAsString('rate_limit_bypassed_total')).match(
      /scope="orders_write"} (\d+)/,
    )?.[1];
  const before = Number(await bypassed());
  // Відповідь Redis (тут — помилка прав ACL) не схожа на недоступний Redis: ліміт не вимикається.
  const denied = jest
    .spyOn(redis, 'eval')
    .mockRejectedValue(new ReplyError('NOPERM this user has no permissions to run the command'));
  try {
    expect((await api.request(`/orders/${order.id}`, 'DELETE', token)).status).toBe(503);
  } finally {
    denied.mockRestore();
  }
  expect(Number(await bypassed())).toBe(before);
  const offline = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('Connection is closed.'));
  try {
    expect((await api.request(`/orders/${order.id}`, 'DELETE', token)).status).toBe(200);
  } finally {
    offline.mockRestore();
  }
  expect(Number(await bypassed())).toBe(before + 1);
});

it('refuses remote startup when an existing seeded admin keeps another password', async () => {
  await expect(
    api.build({ DEPLOYMENT_MODE: 'remote', ADMIN_PASSWORD: 'different-remote-password' }),
  ).rejects.toThrow(/Remote seeded admin credentials/);
});

it('ignores forwarded client addresses without the ingress credential', async () => {
  await api.restart({ AUTH_RATE_LIMIT: 1 });
  const request = (ip: string) =>
    fetch(api.url() + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: 'wrong-password' }),
      signal: AbortSignal.timeout(5000),
    });
  expect((await request('192.0.2.101')).status).toBe(401);
  expect((await request('192.0.2.102')).status).toBe(429);
});

it('keeps the original absolute refresh expiry after rotation', async () => {
  await api.restart({ JWT_REFRESH_TTL: 60 });
  const response = await api.request('/auth/register', 'POST', undefined, {
    email: `${randomUUID()}@example.test`,
    password: 'strong-test-password',
  });
  const { accessToken, refreshToken } = await response.json();
  expect(claims(accessToken).exp).toBeLessThanOrEqual(claims(refreshToken).exp);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
  try {
    const rotated = await api.request('/auth/refresh', 'POST', undefined, { refreshToken });
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect(claims(next.refreshToken).exp).toBe(claims(refreshToken).exp);
    expect(claims(next.accessToken).exp).toBeLessThanOrEqual(claims(refreshToken).exp);
    expect(next.refreshToken).not.toBe(refreshToken);
  } finally {
    clock.mockRestore();
  }
});

it('issues a websocket token that cannot authenticate an HTTP request', async () => {
  const access = await api.register();
  const response = await api.request('/auth/ws-token', 'POST', access);
  expect(response.status).toBe(200);
  const { token, userId } = await response.json();
  const payload = claims(token);
  expect(payload).toMatchObject({ sub: userId, typ: 'ws', aud: 'private' });
  expect(payload.exp * 1000 - Date.now()).toBeLessThanOrEqual(60_000);
  expect((await api.request('/orders', 'GET', token)).status).toBe(401);
});

it('limits websocket tickets per user before session validation, not per address', async () => {
  const [first, second] = await Promise.all([api.register(), api.register()]);
  const ticket = (access?: string) => api.request('/auth/ws-token', 'POST', access);
  for (let index = 0; index < 120; index++) expect((await ticket(first)).status).toBe(200);
  const denied = await ticket(first);
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
  // Той самий клієнт і адреса: інший користувач за тим самим NAT не втрачає свою квоту.
  expect((await ticket(second)).status).toBe(200);
});

it("rejects invalid websocket ticket requests without spending anyone's quota", async () => {
  const access = await api.register();
  const forged = access.slice(0, -4) + (access.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  for (let index = 0; index < 150; index++) {
    const response = await api.request('/auth/ws-token', 'POST', index % 2 ? forged : undefined);
    expect(response.status).toBe(401);
  }
  expect((await api.request('/auth/ws-token', 'POST', access)).status).toBe(200);
});

it('never extends the session deadline through a generated sequence of rotations', async () => {
  await api.restart({ JWT_REFRESH_TTL: 60 });
  const registered = await api.request('/auth/register', 'POST', undefined, {
    email: `${randomUUID()}@example.test`,
    password: 'strong-test-password',
  });
  let { refreshToken } = await registered.json();
  const deadline = claims(refreshToken).exp;
  let now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const [advances] = fc.sample(
      fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 8, maxLength: 8 }),
      { numRuns: 1, seed: 20261115 },
    );
    for (const advance of advances) {
      now += advance * 1000;
      const rotated = await api.request('/auth/refresh', 'POST', undefined, { refreshToken });
      expect(rotated.status).toBe(200);
      const next = await rotated.json();
      expect(claims(next.refreshToken).exp).toBe(deadline);
      expect(claims(next.accessToken).exp).toBeLessThanOrEqual(deadline);
      refreshToken = next.refreshToken;
    }
  } finally {
    clock.mockRestore();
  }
});

it('omits the counterparty order id from both submit and replay fills', async () => {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  const sold = await (await api.submit(seller)).json();
  const key = randomUUID();
  const submit = () =>
    api.request(
      '/orders',
      'POST',
      buyer,
      { instrument: 'ABC', side: 'buy', price: '100', quantity: '1' },
      { 'Idempotency-Key': key },
    );
  for (const status of [201, 200]) {
    const response = await submit();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].buyOrderId).toBe(body.order.id);
    expect(body.trades[0]).not.toHaveProperty('sellOrderId');
    expect(JSON.stringify(body.trades)).not.toContain(sold.order.id);
  }
});
