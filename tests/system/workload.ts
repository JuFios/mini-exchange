import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { database, request, submit, token, units, until, verifyReplay, waitReady } from './helpers';

export const SEED = 20261105;
export const ORDER_COUNT = 400;
export const REPLICAS = ['matching-engine-1', 'matching-engine-2'];
export const SETTLEMENT = 'http://settlement-service:3002';

export type Order = {
  auth: string;
  key: string;
  price: string;
  quantity: string;
  side: 'buy' | 'sell';
};

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export async function withFreshBook(test: (db: Client, ledger: Client) => Promise<void>) {
  const db = database();
  const ledger = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.LEDGER_DATABASE_USER,
    password: process.env.LEDGER_DATABASE_PASSWORD,
    database: process.env.LEDGER_DATABASE_NAME,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  try {
    await db.connect();
    const { rows } = await db.query('SELECT pg_try_advisory_lock(894215631024) AS acquired');
    assert(rows[0].acquired, 'Another system workload is using this database');
    await ledger.connect();
    await Promise.all(REPLICAS.map((replica) => waitReady(replica)));
    const state = await owner(db);
    assert.equal(state.last_applied_seq, '0', 'Run against a fresh test stack');
    const {
      rows: [instrument],
    } = await db.query("SELECT next_seq FROM instruments WHERE symbol='ABC'");
    assert.equal(instrument.next_seq, '0', 'ABC must have an empty command journal');
    await test(db, ledger);
  } finally {
    await Promise.all([db.end(), ledger.end()]);
  }
}

export function adminToken() {
  return token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
}

export function testUser() {
  return token('register', `${randomUUID()}@system.test`, 'system-user-password');
}

export async function orders(): Promise<Order[]> {
  const users = await Promise.all(Array.from({ length: 20 }, testUser));
  await Promise.all(
    users.map(async (auth) => {
      const response = await request('/wallets', 'GET', auth, undefined, SETTLEMENT);
      assert.equal(response.status, 200, await response.clone().text());
      const wallets = (await response.json()) as {
        asset: string;
        available: string;
        reserved: string;
      }[];
      assert.deepEqual(
        wallets
          .filter(({ asset }) => asset === 'ABC' || asset === 'USD')
          .map(({ asset, available, reserved }) => ({ asset, available, reserved })),
        [
          { asset: 'ABC', available: '1000.00000000', reserved: '0.00000000' },
          { asset: 'USD', available: '100000.0000000000', reserved: '0.0000000000' },
        ],
      );
    }),
  );
  const random = mulberry32(SEED);
  return Array.from({ length: ORDER_COUNT }, (_, i) => ({
    auth: users[i % users.length],
    key: `run-${SEED}-${i}`,
    price: ((9900 + Math.floor(random() * 201)) / 100).toFixed(2),
    quantity: ((1 + Math.floor(random() * 20)) / 10).toFixed(1),
    side: (Math.floor(i / users.length) + (i % users.length)) % 2 ? 'sell' : 'buy',
  }));
}

export async function sendOrder(order: Order, retry: boolean) {
  const { auth, key, ...body } = order;
  const response = await submit(auth, { ...body, instrument: 'ABC' }, undefined, { key, retry });
  return {
    key,
    status: response.status,
    body: (await response.json()) as { order?: { id: string }; code?: string },
  };
}

export type Receipt = Awaited<ReturnType<typeof sendOrder>>;

export function assertAccepted(receipts: Receipt[]) {
  const failures = receipts.filter(({ status }) => status < 200 || status >= 300);
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 10)));
  assert.equal(receipts.filter(({ status }) => status === 422).length, 0);
  for (const { body } of receipts) assert(body.order?.id);
  assert.equal(new Set(receipts.map(({ body }) => body.order!.id)).size, ORDER_COUNT);
}

export async function owner(db: Client) {
  const { rows } = await db.query<{
    owner_instance: string;
    owner_epoch: string;
    last_applied_seq: string;
    recovered_at: Date | null;
  }>(
    "SELECT owner_instance, owner_epoch, last_applied_seq, recovered_at FROM instrument_state WHERE instrument='ABC'",
  );
  assert(rows[0], 'ABC instrument state missing');
  return rows[0];
}

export async function verifyWorkload(
  db: Client,
  ledger: Client,
  admin: string,
  receipts: Receipt[],
  workload: Order[],
) {
  assert.equal(receipts.length, ORDER_COUNT);
  assertAccepted(receipts);
  await until(
    async () => {
      const { rows } = await db.query(
        `SELECT last_applied_seq, (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS unpublished
       FROM instrument_state WHERE instrument='ABC'`,
      );
      const queue = await request('/admin/queue', 'GET', admin, undefined, SETTLEMENT);
      assert(queue.ok, await queue.clone().text());
      const { streams, failures, deadLetters } = (await queue.json()) as {
        streams: { stream: string; lag: number | null; pending: number }[];
        failures: number;
        deadLetters: number;
      };
      assert.equal(failures + deadLetters, 0, 'Settlement queued errors');
      const abc = streams.find(({ stream }) => stream === 'exchange:settlement:{ABC}');
      return (
        rows[0].last_applied_seq === String(ORDER_COUNT) &&
        rows[0].unpublished === 0 &&
        abc?.lag === 0 &&
        abc.pending === 0
      );
    },
    Boolean,
    60000,
  );

  const journal = await db.query(
    `SELECT seq::int, order_id, type, applied_at, user_id, payload FROM order_commands
     WHERE instrument='ABC' ORDER BY seq`,
  );
  assert.deepEqual(
    journal.rows.map(({ seq }) => seq),
    Array.from({ length: ORDER_COUNT }, (_, i) => i + 1),
  );
  assert(journal.rows.every(({ type, applied_at }) => type === 'submit' && applied_at));
  // Replay бере вхід із журналу, тож журнал звіряємо з тим, що надіслав клієнт.
  const sent = new Map(workload.map((order) => [order.key, order]));
  const commands = new Map(journal.rows.map((row) => [row.order_id as string, row]));
  for (const { key, body } of receipts) {
    const order = sent.get(key);
    const command = commands.get(body.order!.id);
    assert(order && command, `Journal has no command for ${key}`);
    assert.deepEqual(
      {
        userId: command.user_id,
        instrument: command.payload.instrument,
        side: command.payload.side,
        price: units(command.payload.price, 2),
        quantity: units(command.payload.quantity, 8),
      },
      {
        userId: subject(order.auth),
        instrument: 'ABC',
        side: order.side,
        price: units(order.price, 2),
        quantity: units(order.quantity, 8),
      },
      `Journal differs from the order sent with ${key}`,
    );
  }
  const accepted = await db.query(
    'SELECT idempotency_key, order_id, status FROM order_requests ORDER BY idempotency_key',
  );
  assert.deepEqual(
    accepted.rows,
    [...receipts]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, body }) => ({
        idempotency_key: key,
        order_id: body.order!.id,
        status: 'accepted',
      })),
  );
  const applied = await db.query(
    "SELECT count(*)::int AS pending FROM orders WHERE status='pending'",
  );
  assert.equal(applied.rows[0].pending, 0);

  const replay = await verifyReplay(db);
  const sum = new Map<string, bigint>();
  for (const trade of replay.trades) {
    for (const id of [trade.buyOrderId, trade.sellOrderId]) {
      sum.set(id, (sum.get(id) ?? 0n) + trade.quantity);
    }
  }
  for (const order of replay.orders) {
    const accounted = order.remaining + (sum.get(order.id) ?? 0n);
    if (order.status === 'cancelled') assert(accounted <= order.quantity);
    else assert.equal(accounted, order.quantity);
  }
  const { bids, asks } = replay.book;
  assert(!bids.length || !asks.length || bids[0].price < asks[0].price, 'Book is crossed');
  const resting = await db.query(
    "SELECT id, price, side, remaining_quantity FROM orders WHERE status IN ('open','partially_filled') ORDER BY id",
  );
  assert.deepEqual(
    resting.rows,
    [...bids, ...asks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((order) => ({
        id: order.id,
        price: decimal(order.price, 2),
        side: order.side,
        remaining_quantity: decimal(order.remaining, 8),
      })),
  );
  const depth = (side: typeof bids) => {
    const levels = new Map<bigint, { quantity: bigint; orders: number }>();
    for (const { price, remaining } of side) {
      const level = levels.get(price) ?? { quantity: 0n, orders: 0 };
      level.quantity += remaining;
      level.orders++;
      levels.set(price, level);
    }
    return [...levels].slice(0, 50).map(([price, { quantity, orders }]) => ({
      price: decimal(price, 2),
      quantity: decimal(quantity, 8),
      orders,
    }));
  };
  const snapshot = await request('/instruments/ABC/book');
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), {
    instrument: 'ABC',
    seq: String(ORDER_COUNT),
    bids: depth(bids),
    asks: depth(asks),
  });
  await verifyLedger(db, ledger, admin, receipts);
  console.log(
    `accepted=${receipts.length} trades=${replay.trades.length} bids=${bids.length} asks=${asks.length} lag=0 reconciliation=ok`,
  );
}

function subject(auth: string): string {
  return JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString()).sub;
}

function decimal(units: bigint, scale: number) {
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

async function verifyLedger(db: Client, ledger: Client, admin: string, receipts: Receipt[]) {
  const reservations = await ledger.query(
    'SELECT reservation_id FROM reservations ORDER BY reservation_id',
  );
  assert.deepEqual(
    reservations.rows.map(({ reservation_id }) => reservation_id),
    receipts.map(({ body }) => body.order!.id).sort(),
  );
  const expected = await db.query(
    `SELECT t.trade_id, CASE WHEN o.price > t.price THEN 5 ELSE 4 END AS postings
     FROM trades t JOIN orders o ON o.id=t.buyer_order_id ORDER BY t.trade_id`,
  );
  const settled = await ledger.query(
    `SELECT t.trade_id, count(p.id)::int AS postings FROM settled_trades t
     LEFT JOIN postings p ON p.entry_id=t.entry_id GROUP BY t.trade_id ORDER BY t.trade_id`,
  );
  assert(expected.rows.length > 0, 'The workload must produce trades');
  assert.deepEqual(settled.rows, expected.rows);
  const balances = await ledger.query(
    `SELECT asset, sum(balance)::text AS total FROM accounts WHERE asset IN ('ABC','USD')
     GROUP BY asset ORDER BY asset`,
  );
  assert.deepEqual(balances.rows, [
    { asset: 'ABC', total: '0' },
    { asset: 'USD', total: '0' },
  ]);
  const {
    rows: [{ from, to }],
  } = await db.query(
    "SELECT min(accepted_at) - interval '1 second' AS from, clock_timestamp() AS to FROM order_commands",
  );
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    instrument: 'ABC',
  });
  const report = await request(
    `/admin/reconciliation?${params}`,
    'POST',
    admin,
    undefined,
    SETTLEMENT,
  );
  assert.equal(report.status, 200, await report.clone().text());
  const reconciliation = (await report.json()) as {
    ok: boolean;
    counts: { matched: number };
    discrepancies: unknown[];
  };
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.discrepancies.slice(0, 5)));
  assert.equal(reconciliation.counts.matched, settled.rows.length);
}
