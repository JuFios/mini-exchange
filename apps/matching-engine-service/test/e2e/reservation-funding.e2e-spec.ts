import { engineApp } from './engine-app';
import { FakeSettlement } from './fakes/settlement.fake';

const api = engineApp();

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
  await api.restart({ RESERVATIONS_ENABLED: false });
  await enabled();
});
