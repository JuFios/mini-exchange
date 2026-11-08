import { engineApp } from './engine-app';
import { waitFor } from '../helpers/wait-for';
import { LeaseManager } from '../../src/ownership/lease-manager';
import { PgNotifications } from '../../src/engine/pg-notifications';

const api = engineApp();
async function admin() {
  const response = await api.request('/auth/login', 'POST', undefined, {
    email: 'admin@demo.local',
    password: 'demo-admin-local-only',
  });
  expect(response.status).toBe(201);
  return (await response.json()).accessToken as string;
}

it('reports pending migrations without leaking pooled connections', async () => {
  const source = api.database();
  const [row] = await source.query(
    'SELECT id,timestamp,name FROM migrations ORDER BY id DESC LIMIT 1',
  );
  const pool = (source.driver as unknown as { master: { totalCount: number; idleCount: number } })
    .master;
  try {
    await source.query('DELETE FROM migrations WHERE id=$1', [row.id]);
    for (let i = 0; i < 20; i++) expect((await api.request('/ready')).status).toBe(503);
  } finally {
    await source.query('INSERT INTO migrations(id,timestamp,name) VALUES ($1,$2,$3)', [
      row.id,
      row.timestamp,
      row.name,
    ]);
  }
  for (let i = 0; i < 20; i++) expect((await api.request('/ready')).status).toBe(200);
  await waitFor(async () => pool.totalCount === pool.idleCount, 3000);
});

it('keeps the admin listing available when Redis cannot report lease TTLs', async () => {
  const redis = api.app().get(LeaseManager).locks.client;
  const pttl = jest.spyOn(redis, 'pttl').mockRejectedValue(new Error('Redis is unavailable'));
  try {
    const response = await api.request('/admin/instruments', 'GET', await admin());
    expect(response.status).toBe(200);
    const rows = await response.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { leaseTtlMs: unknown }) => r.leaseTtlMs === null)).toBe(true);
  } finally {
    pttl.mockRestore();
  }
});

it('waits for a slow owner after it acknowledges a resume request', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const notifications = api.app().get(PgNotifications);
  const answer = (request: { id: string }) => {
    void notifications.ackResume(request.id).then(() => {
      setTimeout(() => void notifications.answerResume(request.id, true), 3500);
    });
  };
  notifications.resumeListeners.add(answer);
  try {
    expect(await notifications.requestResume('ABC')).toBe(true);
  } finally {
    notifications.resumeListeners.delete(answer);
  }
}, 15000);

it('gives up on a missing owner at the acknowledgement deadline', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const started = performance.now();
  expect(await api.app().get(PgNotifications).requestResume('ABC')).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(4500);
}, 10000);

it('returns the best levels of each side in order when the depth is limited', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const token = await api.register();
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const insert = `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,priority_seq,created_at)
    VALUES ($1,'ABC',$2,$3,1,1,'open',$4,now())`;
  let priority = 1;
  for (const [side, price] of [
    ['buy', 98],
    ['buy', 100],
    ['buy', 99],
    ['sell', 103],
    ['sell', 101],
    ['sell', 102],
    ['sell', 101],
  ] as const)
    await api.database().query(insert, [userId, side, price, priority++]);
  const book = await (await api.request('/instruments/ABC/book?depth=2')).json();
  expect(book.bids.map((l: { price: string }) => l.price)).toEqual(['100.00', '99.00']);
  expect(book.asks).toEqual([
    { price: '101.00', quantity: '2.00000000', orders: 2 },
    { price: '102.00', quantity: '1.00000000', orders: 1 },
  ]);
});
