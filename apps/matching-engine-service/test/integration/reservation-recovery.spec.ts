import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { engineApp } from '../e2e/engine-app';
import { FakeSettlement } from '../e2e/fakes/settlement.fake';
import { waitFor } from '../helpers/wait-for';
import type { EngineEnv } from '../../src/config/env.validation';

const engine = engineApp();
const body = { instrument: 'ABC', side: 'buy', price: 101, quantity: 2 };
const key = 'reservation-crash';

let fake: FakeSettlement;
let url: string;

beforeEach(async () => {
  fake = new FakeSettlement(process.env.INTERNAL_API_TOKEN!);
  url = await fake.start();
});

afterEach(async () => {
  await fake.close();
});

function settings(intervalMs = 100): Partial<EngineEnv> {
  return {
    ENGINE_WORKER_ENABLED: false,
    ORDER_SYNC_WAIT_MS: 20,
    RESERVATIONS_ENABLED: true,
    RESERVATION_SWEEP_AFTER_MS: 500,
    RESERVATION_SWEEP_INTERVAL_MS: intervalMs,
    RESERVATION_TIMEOUT_MS: 500,
    SETTLEMENT_URL: url,
  };
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  expect(child.kill('SIGKILL')).toBe(true);
  expect((await exit)[1]).toBe('SIGKILL');
}

async function withIntakeChild(
  run: (child: ChildProcess, base: string) => Promise<void>,
): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(settings()).map(([key, value]) => [key, String(value)]),
  );
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', 'test/helpers/intake-process.ts'],
    {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let diagnostics = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  try {
    const ready = /INTAKE_READY (http:\/\/[^\s]+)/;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Child failed: ${diagnostics}`);
      return ready.test(output);
    }, 10000);
    await run(child, ready.exec(output)![1]);
  } finally {
    await kill(child);
  }
}

async function crashAfterReserve(token: string): Promise<string> {
  fake.holdReserve = true;
  await withIntakeChild(async (child, base) => {
    const request = fetch(`${base}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    try {
      await waitFor(async () => fake.reserveIds.length > 0, 3000);
      expect(fake.reservations.get(fake.reserveIds[0])).toMatchObject({
        asset: 'USD',
        amount: '2020000000000',
      });
      expect(await state(fake.reserveIds[0])).toMatchObject({ status: 'reserving' });
      await kill(child);
    } finally {
      await request;
    }
  });
  fake.holdReserve = false;
  return fake.reserveIds[0];
}

async function state(orderId: string): Promise<{ status: string; release_attempts: number }> {
  const [row] = await engine
    .database()
    .query('SELECT status, release_attempts FROM order_requests WHERE order_id=$1', [orderId]);
  return row;
}

function repeat(token: string) {
  return engine.request('/orders', 'POST', token, body, { 'Idempotency-Key': key });
}

it('retries a reserved request after SIGKILL with the same order and one command', async () => {
  const token = await engine.register();
  const orderId = await crashAfterReserve(token);
  await engine.restart(settings(10000));
  const response = await repeat(token);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ order: { id: orderId } });
  expect(fake.reserveIds).toEqual([orderId, orderId]);
  expect(await engine.database().query('SELECT order_id FROM order_commands')).toEqual([
    { order_id: orderId },
  ]);
}, 20000);

it('expires an abandoned reservation within two seconds and rejects a delayed replay', async () => {
  const token = await engine.register();
  const orderId = await crashAfterReserve(token);
  await engine.restart(settings());
  await waitFor(async () => (await state(orderId)).status === 'expired', 2000);
  expect(fake.releaseIds).toEqual([orderId]);
  expect([...fake.released]).toEqual([orderId]);
  const response = await repeat(token);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'REQUEST_EXPIRED' });
}, 20000);

it('retries three release failures from releasing and increments the failure metric three times', async () => {
  const token = await engine.register();
  const orderId = await crashAfterReserve(token);
  fake.failReleases = 3;
  await engine.restart(settings(200));
  await waitFor(async () => (await state(orderId)).release_attempts === 3, 2000);
  expect(await state(orderId)).toEqual({ status: 'releasing', release_attempts: 3 });
  expect(fake.released.size).toBe(0);
  await waitFor(async () => (await state(orderId)).status === 'expired', 2000);
  expect(fake.releaseIds).toEqual(Array.from({ length: 4 }, () => orderId));
  expect([...fake.released]).toEqual([orderId]);
  expect(await (await engine.request('/metrics')).text()).toMatch(
    /^reservation_release_failures_total 3$/m,
  );
}, 20000);

it('resumes an in-flight release after the sweeper is killed and releases once', async () => {
  const token = await engine.register();
  const orderId = await crashAfterReserve(token);
  fake.failReleases = 3;
  fake.holdRelease = true;
  await withIntakeChild(async (child) => {
    await waitFor(async () => fake.releaseIds.length >= 4, 4000);
    expect(await state(orderId)).toEqual({ status: 'releasing', release_attempts: 3 });
    await kill(child);
  });
  fake.holdRelease = false;
  await engine.restart(settings());
  await waitFor(async () => (await state(orderId)).status === 'expired', 4000);
  expect([...fake.released]).toEqual([orderId]);
  expect(fake.releaseIds).toEqual(Array.from({ length: 5 }, () => orderId));
}, 25000);

it('returns 422 for insufficient funds without issuing a sequence', async () => {
  const token = await engine.register();
  fake.balance = 100_000_000_000n;
  await engine.restart(settings());
  const before = await engine.database().query('SELECT max(seq) AS seq FROM order_commands');
  const response = await repeat(token);
  expect(response.status).toBe(422);
  expect(await engine.database().query('SELECT max(seq) AS seq FROM order_commands')).toEqual(
    before,
  );
  expect(fake.reserveIds).toHaveLength(1);
  expect(fake.reservations.size).toBe(0);
});
