import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from 'pg';
import { runChaos } from './chaos-workload';
import * as helpers from './helpers';
import * as workload from './workload';

function fixture(t: TestContext, slowObservation: boolean, killFails = false) {
  const sent = new Set<string>();
  let killed = false;
  let confirmed = false;
  let lastOldSeq = 0;
  let observations = 0;
  let inspections = 0;
  let attempts = 0;
  const failure = new Error('Docker kill failed');
  const appliedAt = new Date();
  const state = {
    owner_instance: 'engine-1',
    owner_epoch: '1',
    last_applied_seq: '0',
    recovered_at: appliedAt,
  };
  const input = Array.from({ length: 400 }, (_, i) => ({
    auth: 'test-token',
    key: String(i),
    price: '100.00',
    quantity: '1',
    side: 'buy' as const,
  }));
  const db = {
    async query(sql: string) {
      if (sql.includes('ORDER BY seq DESC LIMIT 1')) {
        return {
          rows: [{ seq: String(lastOldSeq), applied_at: appliedAt, result: { epoch: '1' } }],
        };
      }
      if (sql.includes('count(*)::int AS stale')) return { rows: [{ stale: 0 }] };
      // Тест перевіряє бар'єр, а не `resumeMs`: команди, що чекала б під час перехоплення, немає.
      if (sql.includes('accepted_at<=$2')) return { rows: [] };
      assert(sql.includes('SELECT next_seq'));
      return { rows: [{ next_seq: String(sent.size) }] };
    },
  } as unknown as Client;
  t.mock.method(
    workload,
    'withFreshBook',
    async (body: Parameters<typeof workload.withFreshBook>[0]) => body(db, db),
  );
  t.mock.method(workload, 'adminToken', async () => 'admin-token');
  t.mock.method(workload, 'orders', async () => input);
  t.mock.method(workload, 'owner', async () => {
    if (killed) {
      return {
        ...state,
        owner_instance: 'engine-2',
        owner_epoch: '2',
        last_applied_seq: String(sent.size),
        recovered_at: new Date(appliedAt.getTime() + 1000),
      };
    }
    const seq = sent.size;
    if (seq >= 200 && observations++ === 0 && slowObservation) {
      // Повільна відповідь PG дає наступним хвилям час випередити зовнішній kill.
      await delay(800);
    }
    return { ...state, last_applied_seq: String(seq) };
  });
  t.mock.method(workload, 'sendOrder', async (order: (typeof input)[number]) => {
    attempts++;
    const replay = sent.has(order.key);
    if (!replay && sent.size >= 200) {
      assert(confirmed, 'The second half must wait for confirmed SIGKILL');
    }
    sent.add(order.key);
    return { key: order.key, status: replay ? 200 : 201, body: { order: { id: order.key } } };
  });
  t.mock.method(
    workload,
    'verifyWorkload',
    async (_db: Client, _ledger: Client, _admin: string, receipts: workload.Receipt[]) => {
      assert.equal(sent.size, 400);
      assert.deepEqual(
        receipts.map(({ body }) => body.order!.id),
        input.map(({ key }) => key),
      );
    },
  );
  t.mock.method(helpers, 'container', (service: string) => service);
  t.mock.method(helpers, 'waitReady', async () => 200);
  t.mock.method(helpers, 'docker', (...args: string[]) => {
    if (args[0] === 'kill') {
      assert.equal(args[2], 'KILL');
      assert.equal(args[3], 'matching-engine-1');
      lastOldSeq = sent.size;
      if (killFails) throw failure;
      killed = true;
    }
    if (args[0] === 'inspect') {
      if (args[2] === '{{.State.Status}}:{{.State.ExitCode}}') {
        // Docker прийняв kill, але inspect ще не підтвердив завершення процесу.
        if (killed && inspections++ >= 16) {
          confirmed = true;
          return 'exited:137';
        }
        return 'running:0';
      }
      return 'running';
    }
    if (args[0] === 'logs') {
      return `lease acquired instrument=ABC epoch=2\nbook recovered instrument=ABC lastAppliedSeq=${lastOldSeq}`;
    }
    return '';
  });
  return { sent, failure, lastOldSeq: () => lastOldSeq, attempts: () => attempts };
}

for (const slow of [false, true]) {
  test(`external kill holds back load with ${slow ? 'delayed' : 'immediate'} progress observation`, async (t) => {
    const context = fixture(t, slow);
    await runChaos('external');
    assert.equal(context.lastOldSeq(), 200);
    assert.equal(context.sent.size, 400);
  });
}

test('external kill failure rejects held waves without submitting them', async (t) => {
  const context = fixture(t, true, true);
  await assert.rejects(runChaos('external'), context.failure);
  assert.equal(context.sent.size, 200);
  assert.equal(context.attempts(), 200);
});

test('replaces only confirmed expired keys and preserves the final replay key', async (t) => {
  const calls: { body: unknown; key?: string; fresh?: boolean }[] = [];
  t.mock.method(
    helpers,
    'submit',
    async (
      _token: string,
      body: unknown,
      _base: unknown,
      options: { key: string; fresh: boolean },
    ) => {
      calls.push({ body, ...options });
      return calls.length === 1
        ? Response.json({ code: 'REQUEST_EXPIRED' }, { status: 409 })
        : Response.json({ order: { id: 'accepted' } }, { status: options.fresh ? 201 : 200 });
    },
  );
  const order: workload.Order = {
    auth: 'token',
    key: 'first',
    price: '100',
    quantity: '1',
    side: 'buy',
  };
  const accepted = await workload.sendOrder(order, true);
  assert.equal(accepted.status, 201);
  assert.deepEqual(order.expiredKeys, ['first']);
  assert.notEqual(order.key, 'first');
  assert.equal(accepted.key, order.key);
  assert.deepEqual(calls[1].body, { instrument: 'ABC', price: '100', quantity: '1', side: 'buy' });
  const replay = await workload.sendOrder(order, true, false);
  assert.equal(replay.status, 200);
  assert.equal(replay.key, accepted.key);
});

test('does not replace a key for another conflict or an explicit replay', async (t) => {
  for (const [code, fresh] of [
    ['IDEMPOTENCY_KEY_REUSED', true],
    ['REQUEST_EXPIRED', false],
  ] as const) {
    const mocked = t.mock.method(helpers, 'submit', async () =>
      Response.json({ code }, { status: 409 }),
    );
    const order: workload.Order = {
      auth: 'token',
      key: 'same',
      price: '100',
      quantity: '1',
      side: 'buy',
    };
    assert.equal((await workload.sendOrder(order, true, fresh)).status, 409);
    assert.equal(order.key, 'same');
    assert.equal(order.expiredKeys, undefined);
    mocked.mock.restore();
  }
});

test('bounds replacements when every reservation expires', async (t) => {
  const mocked = t.mock.method(helpers, 'submit', async () =>
    Response.json({ code: 'REQUEST_EXPIRED' }, { status: 409 }),
  );
  const order: workload.Order = {
    auth: 'token',
    key: 'same',
    price: '100',
    quantity: '1',
    side: 'buy',
  };
  await assert.rejects(workload.sendOrder(order, true), /Too many expired reservation attempts/);
  assert.equal(mocked.mock.callCount(), 4);
  assert.equal(order.expiredKeys?.length, 3);
});
