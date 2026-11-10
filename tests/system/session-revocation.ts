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
  const grace = await rotate();
  assert.equal(grace.status, 200);
  const late = (await grace.json()) as { accessToken: string };
  assert.equal(
    (await request('/wallets', 'GET', late.accessToken, undefined, settlement)).status,
    200,
  );

  const logout = await request('/api/auth/logout', 'POST', undefined, {}, frontend, {
    origin: frontend,
    cookie: 'exchange_refresh=' + first.refreshToken,
  });
  assert.equal(logout.status, 204);
  assert.equal((await rotate()).status, 401);
  const wallet = await request('/wallets', 'GET', late.accessToken, undefined, settlement);
  assert.equal(wallet.status, 401);
  const orders = await request('/api/engine/orders', 'GET', undefined, undefined, frontend, {
    cookie: 'exchange_access=' + late.accessToken,
  });
  assert.equal(orders.status, 401);

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
    'loggedOut=204 lateRefresh=401 settlementWallet=401 frontendOrders=401 privateWs=UNAUTHORIZED',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
