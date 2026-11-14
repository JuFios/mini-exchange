import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import {
  cancelOrder,
  cleanup,
  database,
  engine,
  request,
  submit,
  token,
  until,
  waitReady,
} from './helpers';

const settlement = 'http://settlement-service:3002';
const instrument = 'XYZ';

type Wallet = { asset: string; available: string; reserved: string; version: string };
type Update = Wallet;
type Listener = { socket: Socket; updates: Update[] };

/** Сокет потрапляє в `opened` ще до підключення: його закриють, навіть якщо інший не підключиться. */
function listen(accessToken: string, opened: Listener[]): Promise<Listener> {
  const socket = io(`${engine}/private`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    auth: { token: accessToken },
  });
  const listener = { socket, updates: [] as Update[] };
  opened.push(listener);
  socket.on('wallet.updated', (update: Update) => listener.updates.push(update));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(listener));
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
      last.reserved === wallet.reserved &&
      last.version === wallet.version
    );
  });

async function main() {
  const db = database();
  await db.connect();
  const listeners: Listener[] = [];
  // Заявки, які прибирання скасує: залишок на XYZ зірвав би наступний прогін на перевірці книги.
  const placed: { auth: string; id: string }[] = [];
  let failure: unknown;
  try {
    for (const service of ['matching-engine-1', 'matching-engine-2']) await waitReady(service);
    const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    const [seller, buyer, observer] = await Promise.all(
      [0, 1, 2].map(() => token('register', `${randomUUID()}@system.test`, 'system-user-password')),
    );
    const [sellerPush, buyerPush, observerPush] = await Promise.all(
      [seller, buyer, observer].map((auth) => listen(auth, listeners)),
    );

    // XYZ використовують і `trace`, і `orders:sync`. Вони не лишають заявок, що перетнулися б
    // з ціною 100; інакше покупець виконався б із чужою заявкою, тож це перевіряємо явно.
    const book = await request(`/instruments/${instrument}/book`);
    assert.equal(book.status, 200);
    const { bids, asks } = (await book.json()) as {
      bids: { price: string }[];
      asks: { price: string }[];
    };
    assert(
      !asks.some(({ price }) => Number(price) <= 100) &&
        !bids.some(({ price }) => Number(price) >= 100),
      `XYZ has orders left by another scenario: ${JSON.stringify({ bids, asks })}`,
    );
    const order = { instrument, price: '100', quantity: '1' };
    const resting = await submit(seller, { ...order, side: 'sell' });
    assert([200, 201, 202].includes(resting.status), await resting.clone().text());
    const sellOrderId = ((await resting.json()) as { order: { id: string } }).order.id;
    placed.push({ auth: seller, id: sellOrderId });
    const taking = await submit(buyer, { ...order, side: 'buy' });
    assert([200, 201, 202].includes(taking.status), await taking.clone().text());
    placed.push({ auth: buyer, id: ((await taking.json()) as { order: { id: string } }).order.id });
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
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(
      failure,
      ...listeners.map(
        ({ socket }) =>
          () =>
            socket.disconnect(),
      ),
      // Після угоди обидві заявки виконані, і скасування відповідає 409 ORDER_ALREADY_FILLED.
      ...placed.map(
        ({ auth, id }) =>
          () =>
            cancelOrder(auth, id),
      ),
      () => db.end(),
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
