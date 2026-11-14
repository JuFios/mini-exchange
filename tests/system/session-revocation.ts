import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { engine, request } from './helpers';

const frontend = 'http://engine-lb:3000';
const settlement = 'http://settlement-service:3002';

async function main() {
  const auth = (action: string, body: object) =>
    request('/auth/' + action, 'POST', undefined, body);
  const email = `${randomUUID()}@system.test`;
  const response = await auth('register', { email, password: randomUUID() });
  assert.equal(response.status, 201);
  const first = (await response.json()) as { accessToken: string; refreshToken: string };
  const rotate = () => auth('refresh', { refreshToken: first.refreshToken });
  const rotated = await rotate();
  assert.equal(rotated.status, 200);
  const second = (await rotated.json()) as { accessToken: string };
  const grace = await rotate();
  assert.equal(grace.status, 200);
  const late = (await grace.json()) as { accessToken: string };
  // Logout відкликає сесію, а не один токен: перевіряємо кожен виданий access.
  const tokens = { first: first.accessToken, rotated: second.accessToken, late: late.accessToken };
  for (const [name, accessToken] of Object.entries(tokens)) {
    const wallet = await request('/wallets', 'GET', accessToken, undefined, settlement);
    assert.equal(wallet.status, 200, name);
  }
  // Сокет, відкритий до виходу, має закрити сервер, а не лише нове підключення.
  const open = io(engine + '/private', {
    transports: ['websocket'],
    reconnection: false,
    auth: { token: first.accessToken },
  });
  let closeMs: number;
  // Сокет закривається за будь-якого результату: інакше він тримав би процес до `exp` токена.
  try {
    const closed = new Promise<number>((resolve) =>
      open.once('disconnect', () => resolve(performance.now())),
    );
    await new Promise<void>((resolve, reject) => {
      open.once('connect', () => resolve());
      open.once('connect_error', reject);
    });

    // Звірка сесій може закрити сокет ще до того, як клієнт отримає 204: час рахуємо від запиту.
    const loggedOut = performance.now();
    const logout = await request('/api/auth/logout', 'POST', undefined, {}, frontend, {
      origin: frontend,
      cookie: 'exchange_refresh=' + first.refreshToken,
    });
    assert.equal(logout.status, 204);
    assert.equal((await rotate()).status, 401);
    for (const [name, accessToken] of Object.entries(tokens)) {
      const wallet = await request('/wallets', 'GET', accessToken, undefined, settlement);
      assert.equal(wallet.status, 401, name);
      const engineOrders = await request('/orders', 'GET', accessToken);
      assert.equal(engineOrders.status, 401, name);
      const orders = await request('/api/engine/orders', 'GET', undefined, undefined, frontend, {
        cookie: 'exchange_access=' + accessToken,
      });
      assert.equal(orders.status, 401, name);
    }
    // README обіцяє закриття не пізніше ніж за 13 с після відкликання.
    let timer: NodeJS.Timeout | undefined;
    const closedAt = await Promise.race([
      closed,
      new Promise<undefined>((resolve) => (timer = setTimeout(resolve, 15000, undefined))),
    ]).finally(() => clearTimeout(timer));
    assert(closedAt !== undefined, 'The open private socket stayed connected after logout');
    closeMs = Math.round(closedAt - loggedOut);
    assert(closeMs >= 0 && closeMs <= 13000, `The open private socket closed after ${closeMs}ms`);
  } finally {
    open.disconnect();
  }

  const socket = io(engine + '/private', {
    transports: ['websocket'],
    reconnection: false,
    auth: { token: late.accessToken },
  });
  try {
    const result = await new Promise<string>((resolve) => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', (error) => resolve(error.message));
    });
    assert.equal(result, 'UNAUTHORIZED');
  } finally {
    socket.disconnect();
  }
  console.log(
    `loggedOut=204 lateRefresh=401 tokens=3 settlementWallet=401 engineOrders=401 frontendOrders=401 privateWs=UNAUTHORIZED openSocketClosedMs=${closeMs}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
