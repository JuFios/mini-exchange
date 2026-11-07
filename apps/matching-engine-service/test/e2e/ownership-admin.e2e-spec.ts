import { engineApp } from './engine-app';
import { waitFor } from '../helpers/wait-for';
const api = engineApp();
async function admin() {
  const response = await api.request('/auth/login', 'POST', undefined, {
    email: 'admin@demo.local',
    password: 'demo-admin-local-only',
  });
  expect(response.status).toBe(201);
  return (await response.json()).accessToken as string;
}

it('omits the chaos route when disabled, even for an administrator', async () => {
  const response = await api.request('/admin/chaos', 'POST', await admin(), {
    point: 'after_writes_before_commit',
  });
  expect(response.status).toBe(404);
  const router = api.app().getHttpAdapter().getInstance() as {
    _router: { stack: { route?: { path: string } }[] };
  };
  expect(router._router.stack.some((r) => r.route?.path === '/admin/chaos')).toBe(false);
});

it('protects every registered admin route with authentication and an admin role', async () => {
  const token = await api.register();
  const router = api.app().getHttpAdapter().getInstance() as {
    _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  const routes = router._router.stack.flatMap((r) =>
    r.route && r.route.path.startsWith('/admin') ? [r.route] : [],
  );
  expect(routes.length).toBeGreaterThanOrEqual(2);
  for (const route of routes)
    for (const method of Object.keys(route.methods)) {
      const path = route.path.replace(':instrument', 'ABC');
      expect((await api.request(path, method.toUpperCase())).status).toBe(401);
      expect((await api.request(path, method.toUpperCase(), token)).status).toBe(403);
    }
});

it('halts mismatched recovery, refuses unsafe resume, and applies backlog after the counters are repaired', async () => {
  const token = await api.register();
  const { order } = await (await api.submit(token)).json();
  await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  expect((await api.submit(token, { price: 101 })).status).toBe(202);
  await api
    .database()
    .query("UPDATE instrument_state SET resting_bid_count=1 WHERE instrument='ABC'");
  await api.restart();
  const adminToken = await admin();
  const metrics = await (await api.request('/metrics')).text();
  expect(metrics).toMatch(/engine_recovery_mismatch_total [1-9]/);
  expect(metrics).toContain('engine_instrument_halted{instrument="ABC"} 1');
  expect((await api.submit(token)).status).toBe(503);
  expect((await api.request(`/orders/${order.id}`, 'DELETE', token)).status).toBe(503);
  const first = await api.request('/admin/instruments/ABC/resume', 'POST', adminToken);
  expect(first.status).toBe(409);
  expect((await first.json()).code).toBe('RECOVERY_MISMATCH');
  expect(
    (
      await api
        .database()
        .query("SELECT status,last_applied_seq FROM instrument_state WHERE instrument='ABC'")
    )[0],
  ).toEqual({ status: 'halted', last_applied_seq: '1' });
  await api
    .database()
    .query(
      "UPDATE instrument_state SET resting_bid_count=0,legacy_verified=false WHERE instrument='ABC'",
    );
  expect((await api.request('/admin/instruments/ABC/resume', 'POST', adminToken)).status).toBe(409);
  await api
    .database()
    .query("UPDATE instrument_state SET legacy_verified=true WHERE instrument='ABC'");
  const repaired = await api.request('/admin/instruments/ABC/resume', 'POST', adminToken);
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toEqual({ status: 'active' });
  await waitFor(
    async () =>
      (
        await api
          .database()
          .query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'")
      )[0].last_applied_seq === '2',
  );
  expect(
    (
      await api
        .database()
        .query('SELECT seq FROM order_commands WHERE applied_at IS NOT NULL ORDER BY seq')
    ).map((r: { seq: string }) => r.seq),
  ).toEqual(['1', '2']);
});

it('exposes a healthy standby and rejects an unsafe Redis eviction policy', async () => {
  expect((await api.request('/ready')).status).toBe(200);
  const { LeaseManager } = await import('../../src/ownership/lease-manager');
  const redis = api.app().get(LeaseManager).locks.client;
  try {
    await redis.config('SET', 'maxmemory-policy', 'allkeys-lru');
    expect((await api.request('/ready')).status).toBe(503);
  } finally {
    await redis.config('SET', 'maxmemory-policy', 'noeviction');
  }
  expect((await api.request('/ready')).status).toBe(200);
});

it('routes concurrent resume requests through a standby to the current owner', async () => {
  const peer = await api.build({ INSTANCE_ID: 'resume-standby' });
  try {
    const token = await admin();
    const url = await peer.getUrl();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(`${url}/admin/instruments/ABC/resume`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual(
      Array.from({ length: 3 }, () => ({ status: 'active' })),
    );
    const user = await api.register();
    expect((await api.submit(user)).status).toBe(201);
  } finally {
    await peer.close();
  }
});
