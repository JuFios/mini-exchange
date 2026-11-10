import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from 'pg';
import { container, docker, request, until, waitReady } from './helpers';
import {
  adminToken,
  assertAccepted,
  ORDER_COUNT,
  orders,
  owner,
  sendOrder,
  SETTLEMENT,
  verifyWorkload,
  withFreshBook,
} from './workload';

export type Fault =
  | 'after_writes_before_commit'
  | 'after_commit_before_memory'
  | 'relay_after_xadd_before_published'
  | 'settlement_after_commit_before_ack'
  | 'external'
  | 'pause';

const STREAM = 'exchange:settlement:{ABC}';
type Owner = Awaited<ReturnType<typeof owner>>;

export async function runChaos(fault: Fault) {
  await withFreshBook(async (db, ledger) => {
    const admin = await adminToken();
    const workload = await orders();
    const old = await until(
      () => owner(db),
      (state) => Boolean(state.owner_instance && state.recovered_at),
    );
    const settlementCrash = fault === 'settlement_after_commit_before_ack';
    const service = settlementCrash ? 'settlement-service' : `matching-${old.owner_instance}`;
    const victim = container(service);
    const redis = container('redis');
    try {
      await arm(fault, admin, service, redis, old);
      const results = await Promise.allSettled([
        Promise.all(
          Array.from({ length: 4 }, async (_, wave) => {
            if (wave) await delay(wave * 200);
            return Promise.all(
              workload.slice(wave * 100, (wave + 1) * 100).map((order) => sendOrder(order, true)),
            );
          }),
        ),
        recover(db, ledger, fault, old, victim, service, redis),
      ] as const);
      const [load, recovery] = results;
      if (recovery.status === 'rejected') throw recovery.reason;
      if (load.status === 'rejected') throw load.reason;
      const receipts = load.value.flat();
      await verifyWorkload(db, ledger, admin, receipts);
      const retries = await Promise.all(workload.map((order) => sendOrder(order, true)));
      assertAccepted(retries);
      assert(retries.every(({ status }) => status === 200));
      assert.deepEqual(
        retries.map(({ body }) => body.order!.id),
        receipts.map(({ body }) => body.order!.id),
      );
      assert.equal((await owner(db)).last_applied_seq, String(ORDER_COUNT));
      assert.equal(
        (await db.query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).rows[0].next_seq,
        String(ORDER_COUNT),
      );
    } finally {
      const status = docker('inspect', '--format', '{{.State.Status}}', victim);
      if (status === 'paused') docker('unpause', victim);
      if (status === 'exited') docker('start', victim);
      redisCommand(redis, 'DEL', 'system-test:crash');
    }
  });
}

function redisCommand(redis: string, ...args: string[]) {
  return docker('exec', redis, 'redis-cli', '-e', '--json', ...args);
}

function walletUpdates(redis: string, entryId: string): string[] {
  // Фільтруємо на Redis, щоб не переносити весь stream через Docker CLI.
  const script = `
    local matches = {}
    for _, record in ipairs(redis.call('XRANGE', KEYS[1], '-', '+')) do
      local fields = record[2]
      for i = 1, #fields, 2 do
        if fields[i] == 'envelope' then
          local event = cjson.decode(fields[i + 1])
          if event.type == 'wallet.updated' and event.payload.entryId == ARGV[1] then
            table.insert(matches, event.payload.userId .. ':' .. event.payload.asset)
          end
        end
      end
    end
    return matches
  `;
  return JSON.parse(redisCommand(redis, 'EVAL_RO', script, '1', 'exchange:user-events', entryId));
}

async function arm(fault: Fault, admin: string, service: string, redis: string, old: Owner) {
  if (fault === 'external') return;
  if (
    fault === 'relay_after_xadd_before_published' ||
    fault === 'settlement_after_commit_before_ack'
  ) {
    assert.equal(
      redisCommand(
        redis,
        'SET',
        'system-test:crash',
        fault === 'relay_after_xadd_before_published' ? old.owner_instance : 'settlement',
        'EX',
        '90',
        'NX',
      ),
      '"OK"',
    );
    return;
  }
  const response = await request(
    '/admin/chaos',
    'POST',
    admin,
    { point: fault === 'pause' ? 'stall_before_commit' : fault, fromSeq: 150, requireTrades: true },
    `http://${service}:3001`,
  );
  assert.equal(response.status, 201, await response.clone().text());
}

async function recover(
  db: Client,
  ledger: Client,
  fault: Fault,
  old: Owner,
  victim: string,
  service: string,
  redis: string,
) {
  if (fault === 'external') {
    await until(
      () => owner(db),
      (state) => Number(state.last_applied_seq) >= 200,
      20000,
    );
    docker('kill', '--signal', 'KILL', victim);
  }
  if (fault === 'pause') {
    await pauseInTransaction(db, victim);
  } else {
    await until(
      async () => docker('inspect', '--format', '{{.State.Status}}:{{.State.ExitCode}}', victim),
      (state) => state === 'exited:137',
      25000,
    );
  }
  if (fault === 'settlement_after_commit_before_ack') {
    const event = crashEvent(victim, fault);
    const { rows } = await ledger.query(
      'SELECT entry_id FROM settled_trades WHERE stream_id=$1 AND entry_id IS NOT NULL',
      [event.id],
    );
    assert.equal(rows.length, 1, 'Settlement must commit before the process dies');
    const entryId = rows[0].entry_id as string;
    const originalUpdates = walletUpdates(redis, entryId);
    assert.equal(originalUpdates.length, 4, 'Expected four wallet updates before XACK');
    assert.equal(new Set(originalUpdates).size, 4);
    const pending = () =>
      JSON.parse(
        redisCommand(redis, 'XPENDING', STREAM, 'settlement', event.id, event.id, '1'),
      ) as [string, string, number, number][];
    assert.equal(pending()[0]?.[0], event.id, 'The committed event must remain in the PEL');
    docker('start', victim);
    await until(
      async () =>
        (await request('/ready', 'GET', undefined, undefined, SETTLEMENT).catch(() => null))?.ok,
      Boolean,
      60000,
    );
    assert.equal((await owner(db)).owner_epoch, old.owner_epoch);
    await until(async () => pending().length === 0, Boolean, 60000);
    const recovered = walletUpdates(redis, entryId);
    assert.deepEqual(recovered.slice(4).sort(), originalUpdates.sort());
    console.log(
      `fault=${fault} seq=${event.seq} committed=true pendingBeforeRestart=1 walletUpdatesRepublished=4`,
    );
    return;
  }

  const before = await db.query(
    "SELECT seq, applied_at, result FROM order_commands WHERE instrument='ABC' AND result->>'epoch'=$1 ORDER BY seq DESC LIMIT 1",
    [old.owner_epoch],
  );
  const last = before.rows[0];
  assert(last, 'Old epoch must apply commands before the failure');
  const current = await until(
    () => owner(db),
    (state) =>
      state.owner_instance !== old.owner_instance &&
      BigInt(state.owner_epoch) > BigInt(old.owner_epoch),
    10000,
  );
  assert(current.recovered_at);
  const takeoverMs = current.recovered_at.getTime() - last.applied_at.getTime();
  assert(takeoverMs >= 0 && takeoverMs <= 10000, `takeoverMs=${takeoverMs}`);
  const logs = docker('logs', container(`matching-${current.owner_instance}`));
  assert(logs.includes(`lease acquired instrument=ABC epoch=${current.owner_epoch}`));
  assert(logs.includes(`book recovered instrument=ABC lastAppliedSeq=${last.seq}`));

  await checkFaultResult(db, fault, last, old, victim, redis);
  if (fault === 'pause') docker('unpause', victim);
  else docker('start', victim);
  await waitReady(service);
  const observeUntil = performance.now() + 10000;
  while (performance.now() < observeUntil) {
    const state = await owner(db);
    assert.equal(state.owner_instance, current.owner_instance);
    assert.equal(state.owner_epoch, current.owner_epoch);
    await delay(100);
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS stale FROM order_commands WHERE instrument='ABC' AND seq>$1 AND (result->>'epoch')::bigint <= $2",
        [last.seq, old.owner_epoch],
      )
    ).rows[0].stale,
    0,
  );
  console.log(
    `fault=${fault} oldOwner=${old.owner_instance} owner=${current.owner_instance} lastOldSeq=${last.seq} takeoverMs=${takeoverMs}`,
  );
}

async function pauseInTransaction(db: Client, victim: string) {
  const ip = docker(
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    victim,
  );
  const pid = await until(
    async () =>
      (
        await db.query(
          `SELECT pid FROM pg_stat_activity WHERE client_addr=$1::inet AND state='idle in transaction'
       AND query LIKE 'SELECT pg_notify(''order_applied''%'
       AND clock_timestamp()-state_change > interval '100 milliseconds'`,
          [ip],
        )
      ).rows[0]?.pid as number | undefined,
    Boolean,
    20000,
  );
  docker('pause', victim);
  const paused = await db.query(
    "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='idle in transaction'",
    [pid],
  );
  assert.equal(
    paused.rows.length,
    1,
    'The same transaction must still be open after Docker pauses it',
  );
  await delay(8000);
  const { rows } = await db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid]);
  assert.equal(rows.length, 0, 'PostgreSQL must terminate the paused transaction');
  const output = spawnSync('docker', ['logs', '--tail', '100', container('exchange-db')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(output.status, 0, output.error?.message);
  const logs = output.stdout + output.stderr;
  assert(
    logs
      .split('\n')
      .some(
        (line) =>
          line.includes(`[${pid}]`) &&
          line.includes('terminating connection due to idle-in-transaction timeout'),
      ),
    'PostgreSQL must log the idle timeout of the paused session',
  );
  console.log(`pausedBackend=${pid} pauseMs=8000 terminated=true`);
}

function crashEvent(
  victim: string,
  fault: Fault,
): { point: string; seq: string; eventId: string; id: string } {
  const line = docker('logs', victim)
    .split('\n')
    .find((entry) => entry.startsWith('system-crash '));
  assert(line, `Missing crash marker for ${fault}`);
  const event = JSON.parse(line.slice('system-crash '.length));
  assert.equal(event.point, fault);
  assert(Number(event.seq) >= 150);
  return event;
}

async function checkFaultResult(
  db: Client,
  fault: Fault,
  last: { seq: string; result: { tradeIds: string[]; epoch: string } },
  old: Owner,
  victim: string,
  redis: string,
) {
  if (fault === 'external') {
    assert(Number(last.seq) >= 200 && Number(last.seq) <= 250, `External crash at seq ${last.seq}`);
    return;
  }
  if (fault === 'relay_after_xadd_before_published') {
    const event = crashEvent(victim, fault);
    const records = JSON.parse(redisCommand(redis, 'XRANGE', STREAM, event.id, event.id));
    assert.equal(records[0]?.[0], event.id, 'XADD must survive the process crash');
    assert(records[0][1].includes(event.eventId));
    const replayed = await until(
      async () =>
        (
          JSON.parse(redisCommand(redis, 'XRANGE', STREAM, `(${event.id}`, '+', 'COUNT', '1')) as [
            string,
            string[],
          ][]
        )[0],
      Boolean,
      10000,
    );
    assert(replayed[1].includes(event.eventId), 'Relay must append the same event on recovery');
    const { rows } = await db.query('SELECT seq FROM outbox WHERE event_id=$1', [event.eventId]);
    assert.equal(rows[0]?.seq, event.seq);
    return;
  }
  const postCommit = fault === 'after_commit_before_memory';
  const seq = postCommit ? Number(last.seq) : Number(last.seq) + 1;
  assert(seq >= 150);
  const result = await until(
    async () =>
      (await db.query("SELECT result FROM order_commands WHERE instrument='ABC' AND seq=$1", [seq]))
        .rows[0]?.result as { epoch: string; tradeIds: string[] } | undefined,
    Boolean,
    10000,
  );
  assert(result && result.tradeIds.length > 0);
  if (postCommit) {
    assert.deepEqual(result, last.result);
    assert.equal(result.epoch, old.owner_epoch);
  } else assert(BigInt(result.epoch) > BigInt(old.owner_epoch));
  const { rows } = await db.query(
    "SELECT trade_id FROM trades WHERE instrument='ABC' AND seq=$1 ORDER BY fill_index",
    [seq],
  );
  assert.deepEqual(
    rows.map(({ trade_id }) => trade_id),
    result.tradeIds,
  );
}
