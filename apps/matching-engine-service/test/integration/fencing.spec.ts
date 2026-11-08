import { BookLoader } from '../../src/engine/book-loader';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { engineApp } from '../e2e/engine-app';
import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { OwnershipCoordinator } from '../../src/ownership/ownership-coordinator';
import { LeaseManager } from '../../src/ownership/lease-manager';
import { FencedOutError } from '../../src/ownership/fencing';
import { waitFor } from '../helpers/wait-for';
import type { CommandRow } from '../../src/engine/command';

const api = engineApp();

it('rolls back every application write from a stale epoch and lets the new owner apply the command', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  const token = await api.register();
  expect((await api.submit(token)).status).toBe(202);
  const source = api.database();
  const coordinator = api.app().get(OwnershipCoordinator);
  const lease = (await coordinator.leases.acquire('ABC'))!;
  const owned = await coordinator.recover('ABC', lease);
  const [row]: CommandRow[] = await source.query(
    "SELECT * FROM order_commands WHERE instrument='ABC'",
  );
  let start!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    start = resolve;
  });
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worker = api.app().get(InstrumentWorker);
  const old = source.transaction(async (db) => {
    entered();
    await barrier;
    return worker['applyOne'](db, owned, row);
  });
  const rejected = expect(old).rejects.toBeInstanceOf(FencedOutError);
  await holding;
  await source.query(
    "UPDATE instrument_state SET owner_epoch=owner_epoch+1,owner_instance='new-owner' WHERE instrument='ABC'",
  );
  start();
  await rejected;
  expect(await source.query('SELECT status,version FROM orders')).toEqual([
    { status: 'pending', version: 0 },
  ]);
  expect(
    await source.query(
      'SELECT count(*)::int AS n FROM trades UNION ALL SELECT count(*)::int FROM outbox',
    ),
  ).toEqual([{ n: 0 }, { n: 0 }]);
  expect((await source.query('SELECT applied_at FROM order_commands'))[0].applied_at).toBeNull();
  await api.restart({ INSTANCE_ID: 'new-owner' });
  expect((await api.database().query('SELECT result FROM order_commands'))[0].result.instance).toBe(
    'new-owner',
  );
  expect((await api.database().query('SELECT status FROM orders'))[0].status).toBe('open');
});

it('terminates an idle transaction within two and a half seconds and lets a new owner bump epoch within three seconds', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const source = api.database();
  const config = api.app().get(ConfigService);
  const first = api.app().get(LeaseManager);
  const lease = (await first.acquire('ABC'))!;
  const a = new Client({
    host: config.getOrThrow('DATABASE_HOST'),
    port: config.getOrThrow('DATABASE_PORT'),
    user: config.getOrThrow('DATABASE_USER'),
    password: config.getOrThrow('DATABASE_PASSWORD'),
    database: config.getOrThrow('DATABASE_NAME'),
    options: source.options.type === 'postgres' ? source.options.extra.options : '',
  });
  let killedAt = 0;
  let errorCode: string | undefined;
  a.on('error', (e: Error & { code?: string }) => {
    killedAt = performance.now();
    errorCode ??= e.code;
  });
  const second = new LeaseManager(config);
  try {
    await a.connect();
    expect(
      (await a.query('SHOW idle_in_transaction_session_timeout')).rows[0]
        .idle_in_transaction_session_timeout,
    ).toBe('2s');
    expect((await a.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');
    await a.query('BEGIN');
    await a.query("SELECT * FROM instrument_state WHERE instrument='ABC' FOR UPDATE");
    await a.query("UPDATE instrument_state SET last_applied_seq=99 WHERE instrument='ABC'");
    await first.locks.client.del(lease.key);
    const replacement = await second.acquire('ABC');
    expect(replacement).toBeDefined();
    const started = performance.now();
    const result = await source.query(
      "UPDATE instrument_state SET owner_epoch=owner_epoch+1 WHERE instrument='ABC' RETURNING last_applied_seq",
    );
    expect(performance.now() - started).toBeLessThanOrEqual(3000);
    await waitFor(async () => killedAt > 0);
    expect(killedAt - started).toBeLessThanOrEqual(2500);
    expect(errorCode).toBe('25P03');
    expect(result[0][0].last_applied_seq).toBe('0');
  } finally {
    await a.end().catch(() => undefined);
    await second.onModuleDestroy();
  }
}, 10000);

it('timestamps recovery completion rather than the beginning of its transaction', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const coordinator = api.app().get(OwnershipCoordinator);
  const loader = api.app().get(BookLoader);
  const load = loader.load.bind(loader);
  let afterDelay = 0;
  const delayed = jest.spyOn(loader, 'load').mockImplementation(async (db, instrument, resume) => {
    await db.query('SELECT pg_sleep(0.15)');
    afterDelay = (await db.query('SELECT clock_timestamp() AS instant'))[0].instant.getTime();
    return load(db, instrument, resume);
  });
  try {
    const lease = (await coordinator.leases.acquire('ABC'))!;
    await coordinator.recover('ABC', lease);
    const [state] = await api
      .database()
      .query("SELECT recovered_at FROM instrument_state WHERE instrument='ABC'");
    expect(afterDelay).toBeGreaterThan(0);
    expect(state.recovered_at.getTime()).toBeGreaterThanOrEqual(afterDelay);
  } finally {
    delayed.mockRestore();
  }
});
