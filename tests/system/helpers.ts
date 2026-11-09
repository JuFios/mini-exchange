import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { Client } from 'pg';
import { ReferenceMatcher } from '../../apps/matching-engine-service/test/helpers/reference-matcher';

export const engine = process.env.ENGINE_URL ?? 'http://engine-lb:3001';
export function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}
export function container(service: string): string {
  const project = docker(
    'inspect',
    '--format',
    '{{ index .Config.Labels "com.docker.compose.project" }}',
    hostname(),
  );
  assert(project && project !== '<no value>', 'Missing Compose project label on the harness');
  const ids = docker(
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(ids.length, 1, `Expected exactly one container for ${service}`);
  return ids[0];
}
export function database() {
  return new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=5000',
  });
}
export async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    assert(performance.now() < deadline, 'Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export function waitReady(service: string, timeout = 60000) {
  return until(
    async () => {
      try {
        return (await request('/ready', 'GET', undefined, undefined, `http://${service}:3001`))
          .status;
      } catch {
        return 0;
      }
    },
    (status) => status === 200,
    timeout,
  );
}
export async function request(
  path: string,
  method = 'GET',
  token?: string,
  body?: unknown,
  base = engine,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
export async function submit(token: string, body: unknown, base = engine): Promise<Response> {
  const key = randomUUID();
  const deadline = performance.now() + 30000;
  let attempt = 0;
  let backoff = 250;
  while (performance.now() < deadline) {
    try {
      const response = await request(
        '/orders',
        'POST',
        token,
        body,
        base,
        { 'Idempotency-Key': key },
        Math.max(1, Math.min(15000, Math.floor(deadline - performance.now()))),
      );
      if (![502, 503, 504].includes(response.status)) {
        assert(
          response.status !== 200 || attempt > 0,
          'A fresh order key unexpectedly returned a replay',
        );
        return response;
      }
      await response.text();
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    attempt++;
    console.log(`order retry attempt=${attempt}`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(backoff, deadline - performance.now()))),
    );
    backoff = Math.min(backoff * 2, 2000);
  }
  throw new Error('Order retry deadline exceeded');
}

export async function token(path: string, email: string, password: string) {
  const response = await request(`/auth/${path}`, 'POST', undefined, { email, password });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}
const units = (text: string, scale: number) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
};
export async function verifyReplay(db: Client) {
  const commands = (await db.query('SELECT * FROM order_commands ORDER BY instrument,seq')).rows;
  const oracle = new ReferenceMatcher();
  const expected = [];
  for (const row of commands) {
    const result = oracle.apply(
      row.type === 'submit'
        ? {
            type: 'submit',
            instrument: row.instrument,
            seq: BigInt(row.seq),
            acceptedAt: row.accepted_at.toISOString(),
            order: {
              id: row.order_id,
              ownerId: row.user_id,
              side: row.payload.side,
              price: units(row.payload.price, 2),
              quantity: units(row.payload.quantity, 8),
              remaining: units(row.payload.quantity, 8),
            },
          }
        : { type: 'cancel', orderId: row.order_id },
    );
    expected.push(...result.trades);
  }
  const trades = (await db.query('SELECT * FROM trades ORDER BY instrument,seq,fill_index')).rows;
  assert.deepEqual(
    trades.map((r) => ({
      tradeId: r.trade_id,
      buyOrderId: r.buyer_order_id,
      sellOrderId: r.seller_order_id,
      price: units(r.price, 2),
      quantity: units(r.quantity, 8),
      executedAt: r.executed_at.toISOString(),
      instrument: r.instrument,
    })),
    expected,
  );
  const orders = (await db.query('SELECT * FROM orders ORDER BY id')).rows;
  assert.deepEqual(
    orders.map((r) => ({ id: r.id, status: r.status, remaining: units(r.remaining_quantity, 8) })),
    [...oracle.orders.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, status, remaining }) => ({ id, status, remaining })),
  );
  assert.equal(new Set(trades.map((r) => r.trade_id)).size, trades.length);
  assert(
    commands.every((r) => r.applied_at),
    'All accepted commands must be applied',
  );
  console.log(`replay commands=${commands.length} trades=${trades.length} orders=${orders.length}`);
}
