import { engineApp } from './engine-app';
import { LeaseManager } from '../../src/ownership/lease-manager';

const api = engineApp();

it('exposes the engine metrics and documented HTTP routes', async () => {
  const metrics = await (await api.request('/metrics')).text();
  for (const metric of [
    'engine_commands_applied_total',
    'engine_command_apply_seconds',
    'engine_backlog',
    'engine_owner',
    'engine_lease_renew_failures_total',
    'engine_fenced_writes_total',
    'engine_takeovers_total',
    'engine_recovery_seconds',
    'engine_seq_gap_total',
    'outbox_unpublished',
    'engine_recovery_mismatch_total',
    'engine_instrument_halted',
    'reservation_release_failures_total',
    'ws_replica_lag_seq',
    'ws_clients',
    'orders_rejected_total',
    'rate_limited_total',
  ])
    expect(metrics).toContain(metric);

  const docs = await api.request('/docs-json');
  expect(docs.status).toBe(200);
  const { paths } = (await docs.json()) as { paths: Record<string, unknown> };
  expect(Object.keys(paths)).toEqual(
    expect.arrayContaining([
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
      '/auth/logout',
      '/instruments',
      '/instruments/{instrument}/book',
      '/instruments/{instrument}/trades',
      '/orders',
      '/orders/{id}',
      '/orders/book',
      '/health',
      '/ready',
      '/metrics',
      '/admin/instruments',
      '/admin/instruments/{instrument}/resume',
      '/admin/outbox/redrive',
      '/internal/trades',
    ]),
  );
});

it('reports Redis loss through readiness while liveness stays available', async () => {
  const redis = api.app().get(LeaseManager).locks.client;
  expect((await api.request('/ready')).status).toBe(200);
  redis.disconnect();
  try {
    expect((await api.request('/ready')).status).toBe(503);
    expect((await api.request('/health')).status).toBe(200);
  } finally {
    // Наступний набір використовує той самий Redis: teardown має звільнити lease.
    await redis.connect();
  }
});
