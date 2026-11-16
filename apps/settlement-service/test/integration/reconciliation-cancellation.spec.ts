import { EngineTradesClient } from '../../src/reconciliation/engine-trades.client';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ledgerApp } from '../ledger-app';

let entered!: () => void;
const ledger = ledgerApp(
  {},
  {
    customize: (builder) =>
      builder.overrideProvider(EngineTradesClient).useValue({
        async *trades(_period: unknown, signal: AbortSignal) {
          entered();
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          yield* [];
        },
      }),
  },
);
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };

it('honors an external transaction lock and releases all snapshots after repeated client cancellation', async () => {
  const source = ledger.source();
  const lock = source.createQueryRunner();
  await lock.startTransaction();
  try {
    await lock.query('SELECT pg_advisory_xact_lock(734021,4)');
    await expect(ledger.app().get(ReconciliationService).run(period)).rejects.toMatchObject({
      status: 409,
    });
  } finally {
    await lock.rollbackTransaction();
    await lock.release();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = ledger.app().get(ReconciliationService).run(period, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ status: 503 });
    await started;
    controller.abort();
    await rejected;
    expect(
      await source.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
      ),
    ).toEqual([{ n: 0 }]);
  }
});
