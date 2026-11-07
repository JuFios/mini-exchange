import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { engineApp } from '../e2e/engine-app';
import { waitFor } from '../helpers/wait-for';

const { register, submit, request, restart, database, app } = engineApp();

it('recovers a committed pending command after SIGKILL of the accepting process', async () => {
  const owner = await register();
  await restart({ ENGINE_WORKER_ENABLED: false });
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', 'test/helpers/intake-process.ts'],
    {
      env: { ...process.env, ENGINE_WORKER_ENABLED: 'false', ORDER_SYNC_WAIT_MS: '30' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child did not start: ${diagnostics}`)),
        10000,
      );
      const failed = (code: number | null) => {
        clearTimeout(timer);
        reject(new Error(`Child exited ${code}: ${diagnostics}`));
      };
      child.once('exit', failed);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const ready = /INTAKE_READY (http:\/\/[^\s]+)/.exec(output);
        if (ready) {
          clearTimeout(timer);
          child.off('exit', failed);
          resolve(ready[1]);
        }
      });
    });
    const response = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'durable',
      },
      body: JSON.stringify({ instrument: 'ABC', side: 'sell', price: 100, quantity: 1 }),
    });
    expect(response.status).toBe(202);
    const { order } = await response.json();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    expect((await exited)[1]).toBe('SIGKILL');
    expect(await database().query('SELECT applied_at FROM order_commands')).toEqual([
      { applied_at: null },
    ]);
    await restart();
    expect(await (await request(`/orders/${order.id}`, 'GET', owner)).json()).toMatchObject({
      status: 'open',
      remainingQuantity: '1.00000000',
    });
    expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
      seq: '1',
      asks: [{ quantity: '1.00000000' }],
    });
    expect(
      await database().query(
        'SELECT count(*)::int AS n FROM order_commands WHERE applied_at IS NOT NULL',
      ),
    ).toEqual([{ n: 1 }]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 30000);

it('rolls back orders and trades together and keeps memory unchanged when a trade insert fails', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  await database().query(`CREATE FUNCTION reject_trade() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'trade write rejected'; END; $$;
    CREATE TRIGGER reject_trade BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION reject_trade()`);
  try {
    expect((await submit(buyer, { side: 'buy' })).status).toBe(202);
    expect(await database().query('SELECT count(*)::int AS n FROM trades')).toEqual([{ n: 0 }]);
    expect(await database().query('SELECT status FROM orders ORDER BY priority_seq')).toEqual([
      { status: 'open' },
      { status: 'pending' },
    ]);
    expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
      seq: '1',
      asks: [{ quantity: '1.00000000' }],
      bids: [],
    });
  } finally {
    await database().query('DROP TRIGGER reject_trade ON trades; DROP FUNCTION reject_trade()');
  }
  await app().get(InstrumentWorker).kick('ABC');
  await waitFor(
    async () => (await database().query('SELECT count(*)::int AS n FROM trades'))[0].n === 1,
  );
  expect(await database().query('SELECT status FROM orders ORDER BY priority_seq')).toEqual([
    { status: 'filled' },
    { status: 'filled' },
  ]);
  expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
    seq: '2',
    asks: [],
    bids: [],
  });
});

it('recovers ten thousand resting orders and checks both sides before accepting new work', async () => {
  const owner = await register();
  const userId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url').toString()).sub;
  await app().get(InstrumentWorker).onModuleDestroy();
  await database().query(
    `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,priority_seq,created_at)
    SELECT $1,'ABC','sell',100,1,1,'open',i,now() FROM generate_series(1,10000) i`,
    [userId],
  );
  await database().query(`UPDATE instruments SET next_seq=10000 WHERE symbol='ABC';
    UPDATE instrument_state SET last_applied_seq=10000,resting_count=10000,resting_quantity=1000000000000,
      resting_ask_count=10000,resting_ask_lots=1000000000000 WHERE instrument='ABC'`);
  const started = performance.now();
  await restart();
  const elapsed = performance.now() - started;
  console.log(`Recovery orders=10000 elapsedMs=${elapsed.toFixed(0)}`);
  expect(elapsed * 10).toBeLessThan(50000);
  expect(await (await request('/orders/book?instrument=ABC')).json()).toEqual({
    instrument: 'ABC',
    seq: '10000',
    bids: [],
    asks: [{ price: '100.00', quantity: '10000.00000000', orders: 10000 }],
  });
  expect((await submit(owner, { side: 'buy', price: 90 })).status).toBe(201);
  await database().query(
    "UPDATE instrument_state SET resting_bid_count=0,resting_ask_count=10001 WHERE instrument='ABC'",
  );
  await restart();
  expect((await submit(owner)).status).toBe(503);
}, 30000);

it('reloads committed state when the COMMIT reply is lost and never replays a fill twice', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  const source = database();
  const original = source.createQueryRunner.bind(source);
  let lost = false;
  const interception = jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
    const runner = original(mode);
    const query = runner.query.bind(runner) as (
      sql: string,
      parameters?: unknown[],
      structured?: boolean,
    ) => Promise<unknown>;
    let applying = false;
    runner.query = ((sql: string, parameters?: unknown[], structured?: boolean) => {
      if (sql.includes('SET last_applied_seq')) applying = true;
      return query(sql, parameters, structured);
    }) as typeof runner.query;
    const commit = runner.commitTransaction.bind(runner);
    runner.commitTransaction = async () => {
      await commit();
      if (applying && !lost) {
        lost = true;
        throw new Error('COMMIT acknowledgement lost');
      }
    };
    return runner;
  });
  try {
    expect((await submit(buyer, { side: 'buy' })).status).toBe(201);
    await waitFor(
      async () => (await (await request('/orders/book?instrument=ABC')).json()).seq === '2',
    );
    expect(lost).toBe(true);
    expect(await database().query('SELECT count(*)::int AS n FROM trades')).toEqual([{ n: 1 }]);
    expect((await submit(seller, { price: 101 })).status).toBe(201);
    expect(await database().query('SELECT count(*)::int AS n FROM trades')).toEqual([{ n: 1 }]);
    expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
      seq: '3',
      asks: [{ price: '101.00' }],
    });
  } finally {
    interception.mockRestore();
  }
});

it('returns an order and its trades from one snapshot while another command fills it', async () => {
  const seller = await register();
  const buyer = await register();
  const body = { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 };
  const { order } = await (
    await request('/orders', 'POST', seller, body, { 'Idempotency-Key': 'snapshot' })
  ).json();
  const source = database();
  const original = source.createQueryRunner.bind(source);
  let entered!: () => void;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  const interception = jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
    const runner = original(mode);
    const query = runner.query.bind(runner) as (
      sql: string,
      parameters?: unknown[],
      structured?: boolean,
    ) => Promise<unknown>;
    let reading = false;
    runner.query = (async (sql: string, parameters?: unknown[], structured?: boolean) => {
      const result = await query(sql, parameters, structured);
      if (sql === 'SET TRANSACTION READ ONLY') reading = true;
      if (
        reading &&
        !intercepted &&
        sql.includes('FROM "orders"') &&
        parameters?.includes(order.id)
      ) {
        intercepted = true;
        entered();
        await gate;
      }
      return result;
    }) as typeof runner.query;
    return runner;
  });
  const repeat = request('/orders', 'POST', seller, body, { 'Idempotency-Key': 'snapshot' });
  let rejectBarrier!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectBarrier = reject;
  });
  const timeout = setTimeout(() => rejectBarrier(new Error('Read barrier timed out')), 3000);
  try {
    await Promise.race([barrier, deadline]);
    expect((await submit(buyer, { side: 'buy' })).status).toBe(201);
    release();
    const response = await repeat;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      order: { status: 'open', filledQuantity: '0.00000000' },
      trades: [],
    });
    expect(await (await request(`/orders/${order.id}`, 'GET', seller)).json()).toMatchObject({
      status: 'filled',
    });
  } finally {
    clearTimeout(timeout);
    release();
    await repeat.catch(() => undefined);
    interception.mockRestore();
  }
});
