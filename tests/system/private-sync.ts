import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { readActiveOrders } from '../../apps/frontend/lib/active-orders';
import { engine, request, submit, token, until, waitReady } from './helpers';

const instrument = 'XYZ';
const ACTIVE = 60;

type Order = { id: string; status: string; version: number; createdAt: string };
type Update = { orderId: string; status: string; version: number };

async function page(accessToken: string, query: string): Promise<Order[]> {
  const response = await request(`/orders?${query}`, 'GET', accessToken);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Order[];
}

async function main() {
  for (const service of ['matching-engine-1', 'matching-engine-2']) await waitReady(service);
  const owner = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
  const buyer = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
  const updates: Update[] = [];
  const socket: Socket = io(`${engine}/private`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    auth: { token: owner },
  });
  socket.on('order.updated', (update: Update) => updates.push(update));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const placed: string[] = [];
  let taken: string | undefined;
  let failure: unknown;
  try {
    // 60 активних заявок далеко від ринку: вони не зіставляються й не заважають іншим сценаріям.
    const sell = async (price: number) => {
      const response = await submit(owner, {
        instrument,
        side: 'sell',
        price: String(price),
        quantity: '0.1',
      });
      assert([200, 201, 202].includes(response.status), await response.clone().text());
      const { order } = (await response.json()) as { order: { id: string } };
      placed.push(order.id);
      return order.id;
    };
    for (let batch = 0; batch < ACTIVE; batch += 10)
      await Promise.all(Array.from({ length: 10 }, (_, i) => sell(500 + batch + i)));
    // Заявка, що стане `filled`, поки клієнт без зв'язку.
    const raced = await sell(400);
    const taking = await submit(buyer, {
      instrument,
      side: 'buy',
      price: '400',
      quantity: '0.1',
    });
    assert([200, 201, 202].includes(taking.status), await taking.clone().text());
    taken = ((await taking.clone().json()) as { order: { id: string } }).order.id;

    await until(
      async () => updates.filter(({ status }) => status === 'open').length,
      (opened) => opened >= ACTIVE + 1,
      30000,
    );
    await until(
      async () => updates.some(({ orderId, status }) => orderId === raced && status === 'filled'),
      Boolean,
      30000,
    );
    // Розрив: клієнт губить події `filled`, а буфер зберігає лише ранішу `open`.
    const buffered = updates.filter(
      ({ orderId, status }) => !(orderId === raced && status === 'filled'),
    );
    const known = new Set(buffered.map(({ orderId }) => orderId));
    assert(known.has(raced));

    // Старий рецепт: один запит із типовим лімітом. Втрачає заявки й воскрешає виконану.
    const single = await page(owner, 'status=active');
    assert(single.length < ACTIVE, `A single page returned ${single.length} orders`);
    const naive = new Map(single.map((order) => [order.id, order.status]));
    for (const { orderId, status } of buffered) if (!naive.has(orderId)) naive.set(orderId, status);
    assert.equal(naive.get(raced), 'open', 'The old recipe revives a filled order');

    // Рецепт README тим самим кодом, що й термінал: усі сторінки (малий ліміт змушує брати
    // кілька), потім відсутні за ID.
    const pages = await readActiveOrders((query) => page(owner, query), 25);
    assert.equal(pages.length, ACTIVE);
    assert.equal(new Set(pages.map(({ id }) => id)).size, ACTIVE, 'Pages must not repeat orders');
    const state = new Map(pages.map((order) => [order.id, order]));
    for (const id of known) {
      if (state.has(id)) continue;
      const response = await request(`/orders/${id}`, 'GET', owner);
      assert.equal(response.status, 200, await response.clone().text());
      state.set(id, (await response.json()) as Order);
    }
    for (const update of buffered) {
      const current = state.get(update.orderId);
      assert(current, `Order ${update.orderId} is unknown after the sync`);
      // Подія застосовується лише з більшою версією, ніж у REST.
      if (update.version > current.version) current.status = update.status;
    }
    assert.equal(state.get(raced)?.status, 'filled');
    assert(state.get(raced)!.version >= 2);
    assert.equal([...state.values()].filter(({ status }) => status === 'open').length, ACTIVE);
    console.log(
      `private sync active=${ACTIVE} singlePage=${single.length} pages=3 raced=filled oldRecipe=revived`,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    socket.disconnect();
    // Залишки на XYZ зачепили б `wallet:push` у наступному прогоні, тож скасування перевіряємо.
    const problems: string[] = [];
    const orders = [
      ...placed.map((id) => ({ id, auth: owner })),
      ...(taken ? [{ id: taken, auth: buyer }] : []),
    ];
    for (const { id, auth } of orders) {
      const cancel = await request(`/orders/${id}`, 'DELETE', auth);
      const body = await cancel.text();
      // Виконану заявку скасувати не можна, і залишку в неї немає.
      const filled = cancel.status === 409 && body.includes('ORDER_ALREADY_FILLED');
      if (![200, 202].includes(cancel.status) && !filled)
        problems.push(`Cancel ${id}: ${cancel.status} ${body}`);
    }
    // Збій прибирання не ховає первинну помилку сценарію.
    if (problems.length && failure) console.error(problems.join('\n'));
    else assert.equal(problems.length, 0, problems.join('\n'));
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
