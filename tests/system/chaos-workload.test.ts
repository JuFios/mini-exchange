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
