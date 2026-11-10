import request from 'supertest';
import { ledgerApp } from '../ledger-app';

const ledger = ledgerApp({}, { consumer: true });

it('exposes settlement metrics, readiness, CORS and documented HTTP routes', async () => {
  const server = ledger.app().getHttpServer();
  const metrics = await request(server).get('/metrics').expect(200);
  for (const name of [
    'settlement_trades_total',
    'settlement_stream_lag',
    'settlement_pending',
    'settlement_dlq_total',
    'settlement_trimmed_pending_total',
  ])
    expect(metrics.text).toContain(name);
  await request(server).get('/ready').expect(200);
  await request(server)
    .get('/health')
    .set('Origin', 'http://localhost:3000')
    .expect('Access-Control-Allow-Origin', 'http://localhost:3000')
    .expect(200);
  const crossOrigin = await request(server)
    .get('/health')
    .set('Origin', 'https://foreign.example.test');
  expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined();

  const docs = await request(server).get('/docs-json').expect(200);
  expect(Object.keys(docs.body.paths)).toEqual(
    expect.arrayContaining([
      '/wallets',
      '/internal/reservations',
      '/internal/reservations/{id}/release',
      '/trades/settle',
      '/admin/reconciliation',
      '/admin/queue',
      '/health',
      '/ready',
      '/metrics',
    ]),
  );
  expect(docs.body.paths['/admin/reconciliation']).toHaveProperty('post');
  await request(server).get('/admin/reconciliation').expect(404);
});
