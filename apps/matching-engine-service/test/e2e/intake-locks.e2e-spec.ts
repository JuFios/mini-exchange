import type { QueryRunner } from 'typeorm';
import { engineApp } from './engine-app';
import { waitFor } from '../helpers/wait-for';

const api = engineApp();

const blocked = async () =>
  (
    await api
      .database()
      .query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )
  )[0].n > 0;

// Імітує транзакцію, яка вже тримає рядок лічильника інструмента.
async function holdSequence(): Promise<QueryRunner> {
  const runner = api.database().createQueryRunner();
  await runner.startTransaction();
  await runner.query("SET LOCAL idle_in_transaction_session_timeout='0'");
  await runner.query("SELECT 1 FROM instruments WHERE symbol='ABC' FOR UPDATE");
  return runner;
}

it('leaves the instrument state free while an order waits for its sequence', async () => {
  const token = await api.register();
  await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  const holder = await holdSequence();
  const probe = api.database().createQueryRunner();
  try {
    const pending = api.submit(token);
    await waitFor(blocked);

    await probe.startTransaction();
    await expect(
      probe.query("SELECT 1 FROM instrument_state WHERE instrument='ABC' FOR UPDATE NOWAIT"),
    ).resolves.toBeDefined();
    await probe.rollbackTransaction();
    await holder.commitTransaction();

    expect((await pending).status).toBe(202);
  } finally {
    if (probe.isTransactionActive) await probe.rollbackTransaction();
    if (holder.isTransactionActive) await holder.rollbackTransaction();
    await probe.release();
    await holder.release();
  }
});

it('rejects an order that waited while the instrument was halted', async () => {
  const token = await api.register();
  await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  const [{ next_seq: before }] = await api
    .database()
    .query("SELECT next_seq FROM instruments WHERE symbol='ABC'");
  const holder = await holdSequence();
  try {
    const pending = api.submit(token);
    await waitFor(blocked);
    await holder.query("UPDATE instrument_state SET status='halted' WHERE instrument='ABC'");
    await holder.commitTransaction();

    expect((await pending).status).toBe(503);
    const [{ next_seq: after }] = await api
      .database()
      .query("SELECT next_seq FROM instruments WHERE symbol='ABC'");
    expect(after).toBe(before);
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction();
    await holder.release();
    await api
      .database()
      .query("UPDATE instrument_state SET status='active' WHERE instrument='ABC'");
  }
});

it('stamps an order that waited for its sequence with the time it got the sequence', async () => {
  const token = await api.register();
  await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  const holder = await holdSequence();
  try {
    const pending = api.submit(token);
    await waitFor(blocked);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Годинник PG: той самий, що ставить `accepted_at`.
    const [{ now: released }] = await holder.query('SELECT clock_timestamp() AS now');
    await holder.commitTransaction();

    expect((await pending).status).toBe(202);
    const [command] = await api
      .database()
      .query(
        "SELECT c.seq, c.accepted_at, o.created_at FROM order_commands c JOIN orders o ON o.id=c.order_id WHERE c.instrument='ABC' ORDER BY c.seq DESC LIMIT 1",
      );
    // Інакше заявка з більшим seq мала б раніший час, а угода — час раніший за maker.
    expect(command.accepted_at.getTime()).toBeGreaterThanOrEqual(released.getTime());
    expect(command.created_at.getTime()).toBe(command.accepted_at.getTime());
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction();
    await holder.release();
  }
});
