import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  database,
  token,
  request,
  submit,
  until,
  waitReady,
  verifyReplay,
  container,
  docker,
} from './helpers';

async function main() {
  const db = database();
  await db.connect();
  let victim: string | undefined;
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS ok')).rows[0].ok,
      'Another ownership system check is already running',
    );
    for (const service of ['matching-engine-1', 'matching-engine-2']) {
      const id = container(service);
      if (docker('inspect', '--format', '{{.State.Running}}', id) !== 'true') docker('start', id);
      await waitReady(service);
    }
    const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    const regular = await token('register', `${randomUUID()}@system.test`, 'hook-user-password');
    assert.equal(
      (await request('/admin/chaos', 'POST', undefined, { point: 'after_writes_before_commit' }))
        .status,
      401,
    );
    assert.equal(
      (await request('/admin/chaos', 'POST', regular, { point: 'after_writes_before_commit' }))
        .status,
      403,
    );
    for (const point of ['after_writes_before_commit', 'after_commit_before_memory']) {
      const seller = await token('register', `${randomUUID()}@system.test`, 'hook-user-password');
      const buyer = await token('register', `${randomUUID()}@system.test`, 'hook-user-password');
      const accepted = await submit(seller, {
        instrument: 'ABC',
        side: 'sell',
        price: '100',
        quantity: '1',
      });
      assert([200, 201, 202].includes(accepted.status));
      await until(
        async () =>
          (
            await db.query(
              "SELECT last_applied_seq=(SELECT next_seq FROM instruments WHERE symbol='ABC') AS ok FROM instrument_state WHERE instrument='ABC'",
            )
          ).rows[0].ok,
        Boolean,
      );
      const old = (
        await db.query(
          "SELECT owner_instance,owner_epoch,last_applied_seq FROM instrument_state WHERE instrument='ABC'",
        )
      ).rows[0];
      victim = container(`matching-${old.owner_instance}`);
      const armed = await request(
        '/admin/chaos',
        'POST',
        admin,
        { point, fromSeq: Number(old.last_applied_seq) + 1, requireTrades: true },
        `http://matching-${old.owner_instance}:3001`,
      );
      assert.equal(armed.status, 201);
      const response = await submit(buyer, {
        instrument: 'ABC',
        side: 'buy',
        price: '100',
        quantity: '1',
      });
      assert([200, 201, 202].includes(response.status));
      const body = (await response.json()) as { order: { id: string } };
      const current = await until(
        async () =>
          (
            await db.query(
              "SELECT owner_instance,owner_epoch FROM instrument_state WHERE instrument='ABC'",
            )
          ).rows[0],
        (state) =>
          state.owner_instance !== old.owner_instance &&
          BigInt(state.owner_epoch) > BigInt(old.owner_epoch),
        10000,
      );
      const command = await until(
        async () =>
          (await db.query('SELECT * FROM order_commands WHERE order_id=$1', [body.order.id]))
            .rows[0],
        (row) => Boolean(row?.applied_at),
        10000,
      );
      assert(command.result.tradeIds.length > 0);
      if (point === 'after_writes_before_commit')
        assert(BigInt(command.result.epoch) > BigInt(old.owner_epoch));
      else assert.equal(command.result.epoch, old.owner_epoch);
      await verifyReplay(db);
      console.log(
        `hook=${point} command=${command.seq} epoch=${command.result.epoch} ownerEpoch=${current.owner_epoch}: PASS`,
      );
      docker('start', victim);
      victim = undefined;
      for (const service of ['matching-engine-1', 'matching-engine-2']) await waitReady(service);
    }
  } finally {
    if (victim) {
      try {
        docker('start', victim);
      } catch (error) {
        console.error(error);
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
