import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { database, engine, request, submit, token, until, waitReady } from './helpers';

const settlement = 'http://settlement-service:3002';
const instrument = 'XYZ';

type Wallet = { asset: string; available: string; reserved: string };
type Update = Wallet & { version: string };
type Listener = { socket: Socket; updates: Update[] };

function listen(accessToken: string): Promise<Listener> {
  const socket = io(`${engine}/private`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    auth: { token: accessToken },
  });
  const updates: Update[] = [];
  socket.on('wallet.updated', (update: Update) => updates.push(update));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, updates }));
    socket.once('connect_error', reject);
  });
}

async function wallets(accessToken: string): Promise<Wallet[]> {
  const response = await request('/wallets', 'GET', accessToken, undefined, settlement);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Wallet[];
}

/** Остання подія активу збігається з гаманцем у ledger. */
const matches = (updates: Update[], current: Wallet[], assets: string[]) =>
  assets.every((asset) => {
    const last = updates.filter((update) => update.asset === asset).at(-1);
    const wallet = current.find((item) => item.asset === asset);
    return (
      last !== undefined &&
      wallet !== undefined &&
      last.available === wallet.available &&
      last.reserved === wallet.reserved
    );
  });

async function main() {
  const db = database();
  await db.connect();
  const listeners: Listener[] = [];
  try {
    for (const service of ['matching-engine-1', 'matching-engine-2']) await waitReady(service);
    const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    const [seller, buyer, observer] = await Promise.all(
      [0, 1, 2].map(() => token('register', `${randomUUID()}@system.test`, 'system-user-password')),
    );
    const [sellerPush, buyerPush, observerPush] = await Promise.all(
      [seller, buyer, observer].map(listen),
    );
    listeners.push(sellerPush, buyerPush, observerPush);

    // XYZ не використовують інші сценарії, тож на книзі немає чужих заявок і угода лише ця.
    const order = { instrument, price: '100', quantity: '1' };
    const resting = await submit(seller, { ...order, side: 'sell' });
    assert([200, 201, 202].includes(resting.status), await resting.clone().text());
    const sellOrderId = ((await resting.json()) as { order: { id: string } }).order.id;
    const taking = await submit(buyer, { ...order, side: 'buy' });
    assert([200, 201, 202].includes(taking.status), await taking.text());
    await until(
      async () =>
        (await db.query('SELECT 1 FROM trades WHERE seller_order_id = $1', [sellOrderId])).rowCount,
      Boolean,
      30000,
    );
    await until(
      async () =>
        (await (await request('/admin/queue', 'GET', admin, undefined, settlement)).json()) as {
          streams: { lag: number; pending: number }[];
        },
      ({ streams }) => streams.every(({ lag, pending }) => lag === 0 && pending === 0),
      30000,
    );

    // Обидва боки бачать і base, і quote; після розрахунку push збігається з GET /wallets.
    const assets = [instrument, 'USD'];
    for (const [name, token, push] of [
      ['seller', seller, sellerPush],
      ['buyer', buyer, buyerPush],
    ] as const) {
      await until(async () => matches(push.updates, await wallets(token), assets), Boolean, 10000);
      for (const asset of assets) {
        const versions = push.updates
          .filter((update) => update.asset === asset)
          .map(({ version }) => BigInt(version));
        assert(versions.length >= 1, `${name} got no ${asset} update`);
        assert(
          versions.every((version, i) => i === 0 || version > versions[i - 1]),
          `${name} ${asset} versions must grow: ${versions.join(',')}`,
        );
      }
    }
    assert(
      sellerPush.updates.filter(({ asset }) => asset === instrument).length >= 2,
      'The seller must see the reserve and the trade in the base asset',
    );
    assert(
      buyerPush.updates.filter(({ asset }) => asset === 'USD').length >= 2,
      'The buyer must see the reserve and the trade in the quote asset',
    );
    assert.deepEqual(observerPush.updates, [], 'A third user must receive no wallet updates');
    assert(
      !JSON.stringify([sellerPush.updates, buyerPush.updates]).includes('userId'),
      'Wallet updates must not carry identities',
    );
    console.log(
      `wallet push seller=${sellerPush.updates.length} buyer=${buyerPush.updates.length} observer=0`,
    );
  } finally {
    for (const { socket } of listeners) socket.disconnect();
    await db.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
