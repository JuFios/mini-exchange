import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  container,
  database,
  docker,
  request,
  submit,
  token,
  until,
  waitReady,
  verifyReplay,
} from './helpers';

async function main() {
  const signal = process.argv[2];
  assert(signal === 'TERM' || signal === 'KILL');
  const db = database();
  await db.connect();
  let victim: string | undefined;
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS acquired')).rows[0].acquired,
      'Another ownership system check is already running',
    );
    for (const service of ['matching-engine-1', 'matching-engine-2']) {
      const id = container(service);
      if (docker('inspect', '--format', '{{.State.Running}}', id) !== 'true') docker('start', id);
    }
    for (const replica of ['matching-engine-1', 'matching-engine-2']) await waitReady(replica);
    const seller = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const buyer = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    assert.equal((await request('/admin/instruments', 'GET', admin)).status, 200);
    for (const [auth, side, quantity] of [
      [seller, 'sell', '2'],
      [buyer, 'buy', '1'],
    ] as const) {
      const response = await submit(auth, {
        instrument: 'ABC',
        side,
        price: '100',
        quantity,
      });
      assert([200, 201, 202].includes(response.status), await response.text());
    }
    await until(
      async () =>
        (
          await db.query(
            "SELECT last_applied_seq=max_seq AS done FROM (SELECT last_applied_seq,(SELECT next_seq FROM instruments WHERE symbol='ABC') AS max_seq FROM instrument_state WHERE instrument='ABC') s",
          )
        ).rows[0].done,
      Boolean,
    );
    const previous = (
      await db.query(
        "SELECT owner_instance,owner_epoch,last_applied_seq,(SELECT max(applied_at) FROM order_commands WHERE instrument='ABC' AND result->>'epoch'=s.owner_epoch::text) AS applied_at FROM instrument_state s WHERE instrument='ABC'",
      )
    ).rows[0];
    assert(['engine-1', 'engine-2'].includes(previous.owner_instance));
    victim = container(`matching-${previous.owner_instance}`);
    docker('kill', '--signal', signal, victim);
    const current = await until(
      async () =>
        (
          await db.query(
            "SELECT owner_instance,owner_epoch,recovered_at FROM instrument_state WHERE instrument='ABC'",
          )
        ).rows[0],
      (r) =>
        r.owner_instance !== previous.owner_instance &&
        BigInt(r.owner_epoch) > BigInt(previous.owner_epoch),
      10000,
    );
    const takeoverMs = current.recovered_at.getTime() - previous.applied_at.getTime();
    const limit = signal === 'TERM' ? 2000 : 10000;
    assert(takeoverMs >= 0 && takeoverMs <= limit, `takeoverMs=${takeoverMs} exceeds ${limit}`);
    console.log(
      `signal=${signal} oldOwner=${previous.owner_instance} owner=${current.owner_instance} epoch=${current.owner_epoch} takeoverMs=${takeoverMs}`,
    );
    const response = await submit(buyer, {
      instrument: 'ABC',
      side: 'buy',
      price: '100',
      quantity: '1',
    });
    assert([200, 201, 202].includes(response.status), await response.text());
    await until(
      async () =>
        (
          await db.query(
            "SELECT last_applied_seq=(SELECT next_seq FROM instruments WHERE symbol='ABC') AS done FROM instrument_state WHERE instrument='ABC'",
          )
        ).rows[0].done,
      Boolean,
    );
    const stale = (
      await db.query(
        "SELECT count(*)::int AS n FROM order_commands WHERE instrument='ABC' AND seq>$1 AND (result->>'epoch')::bigint<=$2",
        [previous.last_applied_seq, previous.owner_epoch],
      )
    ).rows[0].n;
    assert.equal(stale, 0);
    await verifyReplay(db);
  } finally {
    if (victim) {
      try {
        docker('start', victim);
      } catch (error) {
        console.error('Could not restart the tested replica', error);
        process.exitCode = 1;
      }
    }
    await db.end();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
