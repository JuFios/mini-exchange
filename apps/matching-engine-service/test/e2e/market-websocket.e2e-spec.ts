import { Socket } from 'socket.io-client';
import { waitFor } from '../helpers/wait-for';
import { connect, emitWithAck, payloads, record } from '../helpers/websocket';
import { engineApp } from './engine-app';

const api = engineApp();
const EVENTS = ['book.delta', 'trade', 'book.heartbeat'];

let socket: Socket | undefined;
afterEach(() => socket?.disconnect());

async function subscribe(instrument = 'ABC') {
  socket = await connect(api.url(), '/market');
  const received = record(socket, EVENTS);
  const ack = await emitWithAck<{ ok: boolean; snapshot?: unknown }>(socket, 'book.subscribe', {
    instrument,
  });
  return { received, ack };
}
const events = payloads;

it('answers a subscription with the instance and a snapshot that matches the public book', async () => {
  const owner = await api.register();
  for (const price of [100, 101, 99]) expect((await api.submit(owner, { price })).status).toBe(201);

  const { ack } = await subscribe();

  const rest = await (await api.request('/instruments/ABC/book')).json();
  expect(ack).toEqual({ ok: true, instance: 'engine-1', snapshot: rest });
  expect(rest.seq).toBe('3');
});

it('sends one delta per command with the command number, the trade and nothing private', async () => {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  const { received } = await subscribe();

  const resting = await (await api.submit(seller, { quantity: 2 })).json();
  expect((await api.submit(buyer, { side: 'buy', quantity: 1 })).status).toBe(201);
  expect((await api.request(`/orders/${resting.order.id}`, 'DELETE', seller)).status).toBe(200);

  await waitFor(async () => events(received, 'book.delta').length === 3, 5000);
  const commands = await api.database().query('SELECT seq FROM order_commands ORDER BY seq');
  const deltas = events(received, 'book.delta') as { seq: string; changes: unknown[] }[];
  expect(deltas.map(({ seq }) => seq)).toEqual(commands.map(({ seq }: { seq: string }) => seq));
  expect(deltas.map(({ changes }) => changes)).toEqual([
    [{ side: 'ask', price: '100.00', quantity: '2.00000000', orders: 1 }],
    [{ side: 'ask', price: '100.00', quantity: '1.00000000', orders: 1 }],
    [{ side: 'ask', price: '100.00', quantity: '0', orders: 0 }],
  ]);

  await waitFor(async () => events(received, 'trade').length === 1, 5000);
  const [trade] = events(received, 'trade') as { tradeId: string; seq: string }[];
  const [latest] = await (await api.request('/instruments/ABC/trades?limit=2')).json();
  expect(trade).toEqual({
    instrument: 'ABC',
    tradeId: latest.tradeId,
    seq: '2',
    price: '100.00',
    quantity: '1.00000000',
    takerSide: 'buy',
    executedAt: latest.executedAt,
  });
  expect(JSON.stringify(received)).not.toMatch(
    /ownerId|userId|buyerUserId|sellerUserId|buyOrderId|sellOrderId|"id"/,
  );
});

it('sends the level that enters the top 50 when the best level of a deeper book is cancelled', async () => {
  const owner = await api.register();
  const ids: string[] = [];
  for (let price = 100; price <= 150; price++) {
    const response = await api.submit(owner, { price });
    expect(response.status).toBe(201);
    ids.push((await response.json()).order.id);
  }
  const { received, ack } = await subscribe();
  const { snapshot } = ack as { snapshot: { asks: { price: string }[] } };
  expect(snapshot.asks).toHaveLength(50);
  expect(snapshot.asks.at(-1)?.price).toBe('149.00');

  expect((await api.request(`/orders/${ids[0]}`, 'DELETE', owner)).status).toBe(200);

  // Delta submit-команд (seq 1…51) можуть дійти після snapshot; клієнт їх відкидає за seq.
  const cancelled = async () =>
    (events(received, 'book.delta') as { seq: string; changes: unknown[] }[]).find(
      ({ seq }) => seq === '52',
    );
  await waitFor(async () => (await cancelled()) !== undefined, 5000);
  expect((await cancelled())?.changes).toEqual([
    { side: 'ask', price: '100.00', quantity: '0', orders: 0 },
    { side: 'ask', price: '150.00', quantity: '1.00000000', orders: 1 },
  ]);
}, 30000);

it('sends the PG sequence in a heartbeat to subscribed clients only', async () => {
  const owner = await api.register();
  const { received } = await subscribe();
  const other = await connect(api.url(), '/market');
  const otherReceived = record(other, EVENTS);
  try {
    expect((await api.submit(owner)).status).toBe(201);
    await waitFor(
      async () => events(received, 'book.heartbeat').some(({ seq }) => seq === '1'),
      6000,
    );
    expect(events(received, 'book.heartbeat')[0]).toEqual({
      instrument: 'ABC',
      seq: expect.any(String),
    });
    expect(otherReceived).toEqual([]);
  } finally {
    other.disconnect();
  }
});

it('stops sending events after unsubscribe and rejects unknown instruments', async () => {
  const owner = await api.register();
  const { received, ack } = await subscribe();
  expect(ack.ok).toBe(true);
  for (const body of [{ instrument: 'NOPE' }, { instrument: '' }, 'ABC', null, {}, [], 42])
    expect(await emitWithAck(socket!, 'book.subscribe', body)).toEqual({
      ok: false,
      error: 'UNKNOWN_INSTRUMENT',
    });

  expect(await emitWithAck(socket!, 'book.unsubscribe', { instrument: 'ABC' })).toEqual({
    ok: true,
  });
  expect((await api.submit(owner)).status).toBe(201);
  await waitFor(
    async () =>
      (
        await api
          .database()
          .query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'")
      )[0].last_applied_seq === '1',
  );
  // Relay публікує протягом сотень мілісекунд; пізніше подія вже була б у кімнаті.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(events(received, 'book.delta')).toEqual([]);
});
