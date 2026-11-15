import { engineApp } from './engine-app';
import { FakeSettlement } from './fakes/settlement.fake';
import { ReservationClient, Reservation } from '../../src/intake/reservation.client';
import fc from 'fast-check';

const api = engineApp();

it('rejects an unfunded insert from a writer that does not know the application guard', async () => {
  const token = await api.register();
  const ownerId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const funded = await api.build({ RESERVATIONS_ENABLED: true, ENGINE_WORKER_ENABLED: false });
  try {
    await expect(
      api.database().query(
        `INSERT INTO orders
      (id,owner_id,instrument,side,price,quantity,remaining_quantity,status,created_at)
      VALUES (gen_random_uuid(),$1,'ABC','sell',100,1,1,'pending',now())`,
        [ownerId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    expect(await api.database().query('SELECT id FROM orders')).toEqual([]);
  } finally {
    await funded.close();
  }
});

it('never commits an unfunded order for any completion order across reservation enablement', async () => {
  const count = 4;
  const releases: (() => void)[] = [];
  let arrived = 0;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  await api.restart({ RESERVATIONS_ENABLED: false }, (builder) => {
    builder.overrideProvider(ReservationClient).useValue({
      reserve: (reservation: Reservation) =>
        new Promise<'accepted'>((resolve) => {
          releases[Number(reservation.limitPrice) - 100] = () => resolve('accepted');
          if (++arrived === count) entered();
        }),
      release: async () => undefined,
    });
  });
  const token = await api.register();
  const pending = Array.from({ length: count }, (_, index) =>
    api.submit(token, { price: 100 + index }),
  );
  for (const response of pending) void response.catch(() => undefined);
  let funded: Awaited<ReturnType<typeof api.build>> | undefined;
  try {
    await Promise.race([
      waiting,
      Promise.all(pending).then(() => {
        throw new Error('Submits completed before the reservation barrier');
      }),
    ]);
    funded = await api.build({ RESERVATIONS_ENABLED: true, ENGINE_WORKER_ENABLED: false });
    const [order] = fc.sample(
      fc.shuffledSubarray(
        Array.from({ length: count }, (_, index) => index),
        { minLength: count, maxLength: count },
      ),
      { numRuns: 1, seed: 20261115 },
    );
    for (const index of order) {
      releases[index]();
      expect((await pending[index]).status).toBe(503);
      expect(await api.database().query('SELECT id FROM orders')).toEqual([]);
    }
  } finally {
    for (const release of releases) release?.();
    await Promise.allSettled(pending);
    await funded?.close();
  }
});

it('refuses an unfunded replica and its writes after another replica requires reservations', async () => {
  const token = await api.register();
  const funded = await api.build({ RESERVATIONS_ENABLED: true, ENGINE_WORKER_ENABLED: false });
  try {
    expect((await api.submit(token)).status).toBe(503);
    await expect(api.build({ RESERVATIONS_ENABLED: false })).rejects.toThrow(
      /reservations are required/,
    );
    expect(await api.database().query('SELECT id FROM orders')).toEqual([]);
  } finally {
    await funded.close();
  }
});

it('gives up an unfunded submit after 3 s while a starting replica holds the mode row', async () => {
  const token = await api.register();
  const runner = api.database().createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // Як старт репліки: тримає рядок довше за межу простою сесії.
    await runner.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    await runner.query('SELECT 1 FROM engine_settings WHERE id=true FOR UPDATE');
    const started = Date.now();
    const response = await api.request(
      '/orders',
      'POST',
      token,
      { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 },
      {},
      10_000,
    );
    // Межа блокування 3 с, а не statement_timeout сесії (5 с).
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(4500);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
  expect(await api.database().query('SELECT id FROM orders')).toEqual([]);
});

it('starts a funded replica again without locking the mode row once reservations are required', async () => {
  await enabled();
  const runner = api.database().createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // Як старт репліки: тримає рядок довше за межу простою сесії.
    await runner.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    await runner.query('SELECT 1 FROM engine_settings WHERE id=true FOR UPDATE');
    const started = Date.now();
    await enabled();
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});

async function enabled() {
  const app = await api.build({ RESERVATIONS_ENABLED: true, ENGINE_WORKER_ENABLED: false });
  await app.close();
}

it('refuses to enable reservations while a live order has none, then accepts the cancelled history', async () => {
  const token = await api.register();
  const { order } = await (await api.submit(token)).json();

  await expect(enabled()).rejects.toThrow(/a live order and no traded order/);

  expect((await api.request(`/orders/${order.id}`, 'DELETE', token)).status).toBe(200);
  await enabled();
});

it('refuses to enable reservations after a trade that was never reserved', async () => {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  await api.submit(seller);
  expect((await api.submit(buyer, { side: 'buy', price: 101 })).status).toBe(201);

  await expect(enabled()).rejects.toThrow(/no live order and a traded order/);
});

it('marks an order as funded only when a real reservation was made', async () => {
  const unfunded = await api.register();
  const { order } = await (await api.submit(unfunded)).json();
  const fake = new FakeSettlement(process.env.INTERNAL_API_TOKEN!);
  try {
    // Заявка без резерву вже є, тож резерви вмикаються на чистій історії.
    expect((await api.request(`/orders/${order.id}`, 'DELETE', unfunded)).status).toBe(200);
    await api.restart({ RESERVATIONS_ENABLED: true, SETTLEMENT_URL: await fake.start() });
    const funded = await api.register();
    expect((await api.submit(funded, { price: 99 })).status).toBe(201);
  } finally {
    await fake.close();
  }
  expect(
    await api.database().query('SELECT reserved FROM order_requests ORDER BY created_at'),
  ).toEqual([{ reserved: false }, { reserved: true }]);
  // Заявка з резервом не блокує повторне ввімкнення.
  await expect(api.build({ RESERVATIONS_ENABLED: false })).rejects.toThrow(
    /reservations are required/,
  );
  await enabled();
});
