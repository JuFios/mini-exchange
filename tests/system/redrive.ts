import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { container, database, docker, request, submit, token, until, waitReady } from './helpers';

const settlement = 'http://settlement-service:3002';
const stream = 'exchange:settlement:{ABC}';

type Report = {
  ok: boolean;
  counts: Record<string, number>;
  discrepancies: { type: string; tradeId: string; actual?: { reservationId?: string } }[];
};

async function main() {
  const db = database();
  await db.connect();
  const settlementContainer = container('settlement-service');
  let ownerContainer: string | undefined;
  try {
    for (const service of ['matching-engine-1', 'matching-engine-2']) {
      const id = container(service);
      if (docker('inspect', '--format', '{{.State.Running}}', id) !== 'true') docker('start', id);
      await waitReady(service);
    }
    const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    // Період починається з цього тесту, тож угоди попередніх сценаріїв не заважають.
    const from = new Date(Date.now() - 1000).toISOString();
    const reconcile = async (): Promise<Report> => {
      const to = new Date(Date.now() + 60_000).toISOString();
      const response = await request(
        `/admin/reconciliation?from=${from}&to=${to}`,
        'GET',
        admin,
        undefined,
        settlement,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as Report;
    };
    const cli = () => {
      try {
        const out = execFileSync(
          'docker',
          ['exec', settlementContainer, 'node', 'dist/reconcile', '--from', from],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return { code: 0, out };
      } catch (error) {
        return { code: (error as { status: number }).status, out: '' };
      }
    };

    const seller = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const buyer = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const order = { instrument: 'ABC', price: '100' };
    const resting = await submit(seller, { ...order, side: 'sell', quantity: '1' });
    assert([200, 201, 202].includes(resting.status), await resting.text());
    await until(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM orders WHERE side='sell' AND status='open' AND created_at >= $1",
            [from],
          )
        ).rowCount,
      Boolean,
    );

    // Власник стоїть, тож заявка покупця приймається, але ще не зіставлена. Settlement
    // ставимо на паузу до того, як угода з'явиться, і видаляємо stream з її подією.
    const owner = (
      await db.query("SELECT owner_instance FROM instrument_state WHERE instrument='ABC'")
    ).rows[0].owner_instance as string;
    ownerContainer = container(`matching-${owner}`);
    docker('pause', ownerContainer);
    // Через балансувальник запит міг би потрапити на призупинену репліку й зависнути до тайм-ауту
    // клієнта (він збігається з тайм-аутом nginx), тож заявку приймає жива репліка напряму.
    const alive = owner === 'engine-1' ? 'matching-engine-2' : 'matching-engine-1';
    const accepted = await submit(
      buyer,
      { ...order, side: 'buy', quantity: '1' },
      `http://${alive}:3001`,
    );
    assert([200, 201, 202].includes(accepted.status), await accepted.text());
    docker('pause', settlementContainer);

    const trade = await until(
      async () =>
        (
          await db.query(
            "SELECT t.trade_id,o.published_at FROM trades t JOIN outbox o ON o.type='trade.executed' AND o.payload->>'tradeId'=t.trade_id::text WHERE t.executed_at >= $1",
            [from],
          )
        ).rows[0],
      (row) => row?.published_at,
      30000,
    );
    const tradeId = trade.trade_id as string;
    const redis = container('redis');
    assert.equal(docker('exec', redis, 'redis-cli', 'DEL', stream), '1');
    docker('unpause', settlementContainer);
    docker('unpause', ownerContainer);
    ownerContainer = undefined;

    const lost = await until(
      reconcile,
      (report) => report.discrepancies.some(({ type }) => type === 'missing'),
      20000,
    );
    assert.equal(lost.ok, false);
    assert.deepEqual(
      lost.discrepancies.filter(({ type }) => type === 'missing').map(({ tradeId }) => tradeId),
      [tradeId],
    );
    assert.equal(cli().code, 1, 'reconcile must exit 1 while a trade is missing');

    const redrive = await request('/admin/outbox/redrive', 'POST', admin, { tradeIds: [tradeId] });
    assert.equal(redrive.status, 200, await redrive.clone().text());
    assert.deepEqual(await redrive.json(), { requeued: 1 });

    const repaired = await until(reconcile, (report) => report.ok && report.counts.matched >= 1);
    assert.equal(repaired.counts.missing, 0);
    assert.equal(cli().code, 0, 'reconcile must exit 0 after the redrive');
    // Втрачений order.closed: заявка скасована, а резерв у ledger лишається активним. Звірка
    // має його назвати, а redrive за orderIds — зняти.
    const maker = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const makerOrder = await submit(maker, {
      instrument: 'ABC',
      price: '200',
      side: 'sell',
      quantity: '1',
    });
    assert([200, 201, 202].includes(makerOrder.status), await makerOrder.clone().text());
    const orderId = ((await makerOrder.json()) as { order: { id: string } }).order.id;
    await until(
      async () => (await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0],
      (row) => row?.status === 'open',
    );
    docker('pause', settlementContainer);
    // XREADGROUP BLOCK, відкритий до паузи, отримав би подію й залишив її у сокеті зупиненого
    // процесу: DEL stream цього не скасує. Чекаємо, поки сервер закриє такі читання за тайм-аутом.
    const blockedReaders = () =>
      docker('exec', redis, 'redis-cli', 'CLIENT', 'LIST')
        .split('\n')
        .filter((client) => client.includes('cmd=xreadgroup') && /flags=[A-Za-z]*b/.test(client))
        .length;
    await until(
      async () => blockedReaders(),
      (blocked) => blocked === 0,
    );
    const cancel = await request(`/orders/${orderId}`, 'DELETE', maker);
    assert([200, 202].includes(cancel.status), await cancel.text());
    await until(
      async () =>
        (
          await db.query(
            "SELECT published_at FROM outbox WHERE type='order.closed' AND payload->>'orderId'=$1",
            [orderId],
          )
        ).rows[0],
      (row) => row?.published_at,
      30000,
    );
    assert.equal(docker('exec', redis, 'redis-cli', 'DEL', stream), '1');
    docker('unpause', settlementContainer);

    const stuckOf = (report: Report) =>
      report.discrepancies.filter(({ type }) => type === 'stuck_reservation');
    const stuck = await until(reconcile, (report) => stuckOf(report).length > 0, 20000);
    assert.equal(stuck.ok, false);
    assert.equal(stuck.counts.stuck_reservation, 1);
    assert.equal(stuckOf(stuck)[0].actual?.reservationId, orderId);
    assert.equal(cli().code, 1, 'reconcile must exit 1 while a reservation is stuck');

    const release = await request('/admin/outbox/redrive', 'POST', admin, { orderIds: [orderId] });
    assert.equal(release.status, 200, await release.clone().text());
    assert.deepEqual(await release.json(), { requeued: 1 });
    const released = await until(reconcile, (report) => report.ok && stuckOf(report).length === 0);
    assert.equal(released.counts.stuck_reservation, 0);
    assert.equal(cli().code, 0, 'reconcile must exit 0 after the reservation is released');

    const queue = await (await request('/admin/queue', 'GET', admin, undefined, settlement)).json();
    assert.equal(
      queue.streams.reduce((n: number, s: { pending: number }) => n + s.pending, 0),
      0,
    );
    console.log(
      `redrive tradeId=${tradeId} missing->ok matched=${repaired.counts.matched} orderId=${orderId} stuck_reservation->ok`,
    );
  } finally {
    // Контейнери не лишаються на паузі, якщо перевірка впала посередині.
    for (const id of [settlementContainer, ownerContainer]) {
      if (id && docker('inspect', '--format', '{{.State.Paused}}', id) === 'true')
        docker('unpause', id);
    }
    await db.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
