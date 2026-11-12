import { RateLimits } from '../../src/security/rate-limits';
import { ReservationClient } from '../../src/intake/reservation.client';
import { waitFor } from '../helpers/wait-for';
import { Logger } from '@nestjs/common';
import { CommandApplier } from '../../src/engine/command-applier';
import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { engineApp } from './engine-app';

const api = engineApp();
const { register, request, submit, restart, database, app } = api;

it('returns the same order for a key and rejects a different payload', async () => {
  const token = await register();
  const body = { instrument: 'ABC', side: 'sell', price: '100', quantity: '1' };
  const first = await request('/orders', 'POST', token, body, {
    'Idempotency-Key': 'same_request',
  });
  const accepted = await first.json();
  expect(first.status).toBe(201);
  const repeated = await request(
    '/orders',
    'POST',
    token,
    { ...body, price: '100.00' },
    { 'Idempotency-Key': 'same_request' },
  );
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(accepted);
  const conflict = await request(
    '/orders',
    'POST',
    token,
    { ...body, quantity: 2 },
    { 'Idempotency-Key': 'same_request' },
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  expect(await database().query('SELECT count(*)::int AS n FROM order_commands')).toEqual([
    { n: 1 },
  ]);
});

it.each(['', 'a'.repeat(65), 'has space', 'bad!'])(
  'rejects an invalid idempotency key %s without accepting a command',
  async (key) => {
    const token = await register();
    const response = await request(
      '/orders',
      'POST',
      token,
      { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 },
      { 'Idempotency-Key': key },
    );
    expect(response.status).toBe(400);
    expect(await database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([
      { next_seq: '0' },
    ]);
  },
);

it('returns an owned order and hides it from another owner while preserving the book alias', async () => {
  const owner = await register();
  const other = await register();
  const { order } = await (await submit(owner)).json();
  expect((await request(`/orders/${order.id}`, 'GET', owner)).status).toBe(200);
  expect((await request(`/orders/${order.id}`, 'GET', other)).status).toBe(404);
  expect((await request('/orders/not-a-uuid', 'GET', owner)).status).toBe(400);
  const book = await request('/orders/book?instrument=ABC');
  expect(book.status).toBe(200);
  expect(await book.json()).toMatchObject({
    instrument: 'ABC',
    seq: '1',
    asks: [{ quantity: '1.00000000' }],
  });
});

it('consumes a cancel queued after a fill when recovering pending commands', async () => {
  const seller = await register();
  const buyer = await register();
  const { order } = await (await submit(seller)).json();
  await restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 50 });
  expect((await submit(buyer, { side: 'buy' })).status).toBe(202);
  const cancellation = request(`/orders/${order.id}`, 'DELETE', seller);
  const pending = await cancellation;
  expect(pending.status).toBe(202);
  const { cancelSeq } = await pending.json();
  expect(cancelSeq).toBe('3');
  await restart();
  expect(await database().query('SELECT result FROM order_commands WHERE seq=3')).toMatchObject([
    { result: { status: 'already_filled' } },
  ]);
  const final = await request(`/orders/${order.id}`, 'DELETE', seller);
  expect(final.status).toBe(409);
  expect(await final.json()).toMatchObject({
    code: 'ORDER_ALREADY_FILLED',
    order: { id: order.id, status: 'filled' },
  });
});

it('returns a synchronous cancel race as a conflict instead of success', async () => {
  const seller = await register();
  const buyer = await register();
  const { order } = await (await submit(seller)).json();
  const worker = app().get(InstrumentWorker);
  const original = worker.kick.bind(worker);
  const pause = jest.spyOn(worker, 'kick').mockResolvedValue();
  const buy = submit(buyer, { side: 'buy' });
  const cancel = (async () => {
    await waitFor(
      async () =>
        (await database().query('SELECT count(*)::int AS n FROM order_commands'))[0].n === 2,
    );
    return request(`/orders/${order.id}`, 'DELETE', seller);
  })();
  await waitFor(
    async () =>
      (await database().query('SELECT count(*)::int AS n FROM order_commands'))[0].n === 3,
  );
  pause.mockRestore();
  await original('ABC');
  expect((await buy).status).toBe(201);
  const response = await cancel;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'ORDER_ALREADY_FILLED',
    order: { status: 'filled' },
  });
});

it('persists an STP cancellation and keeps fills made before the self-cross', async () => {
  const owner = await register();
  const maker = await register();
  await submit(owner);
  await submit(maker, { price: 99 });
  const response = await submit(owner, { side: 'buy', quantity: 2 });
  const { order, trades } = await response.json();
  expect(trades).toMatchObject([{ price: '99.00', quantity: '1.00000000', buyOrderId: order.id }]);
  expect(order).toMatchObject({
    status: 'cancelled',
    filledQuantity: '1.00000000',
    quantity: '2.00000000',
    remainingQuantity: '1.00000000',
    cancelReason: 'self_trade_prevented',
  });
  expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
    bids: [],
    asks: [{ price: '100.00', quantity: '1.00000000' }],
  });
});

it('keeps the whole quantity as the cancelled remainder when no fill precedes the self-cross', async () => {
  const owner = await register();
  await submit(owner);
  const { order, trades } = await (await submit(owner, { side: 'buy', quantity: 2 })).json();
  expect(trades).toEqual([]);
  expect(order).toMatchObject({
    status: 'cancelled',
    quantity: '2.00000000',
    remainingQuantity: '2.00000000',
    filledQuantity: '0.00000000',
  });
});

it('rejects an internal matching error, persists its release, and applies the next command', async () => {
  const applier = new CommandApplier();
  let calls = 0;
  const errorLog = jest.spyOn(Logger.prototype, 'error');
  try {
    await restart({}, (builder) =>
      builder.overrideProvider(CommandApplier).useValue({
        apply: (...args: Parameters<CommandApplier['apply']>) => {
          if (++calls === 1) throw new Error('poison');
          return applier.apply(...args);
        },
      }),
    );
    const token = await register();
    const { order } = await (await submit(token, { side: 'buy', quantity: 2 })).json();
    expect(order).toMatchObject({ status: 'cancelled', cancelReason: 'rejected' });
    expect((await submit(token)).status).toBe(201);
    expect(
      await database().query('SELECT seq,result FROM order_commands ORDER BY seq'),
    ).toMatchObject([
      { seq: '1', result: { status: 'rejected_internal' } },
      { seq: '2', result: { status: 'applied' } },
    ]);
    expect(
      await database().query(
        "SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'",
      ),
    ).toEqual([{ last_applied_seq: '2' }]);
    const outbox = await database().query(
      'SELECT type,payload FROM outbox WHERE seq=1 ORDER BY id',
    );
    expect(outbox).toEqual([
      { type: 'book.delta', payload: { instrument: 'ABC', seq: '1', changes: [] } },
      {
        type: 'order.updated',
        payload: {
          orderId: order.id,
          userId: order.ownerId,
          instrument: 'ABC',
          version: 1,
          status: 'cancelled',
          remainingQuantity: '2.00000000',
          filledQuantity: '0.00000000',
          cancelReason: 'rejected',
        },
      },
      {
        type: 'order.closed',
        payload: expect.objectContaining({
          reason: 'rejected',
          releasedAmount: '2000000000000',
          orderId: order.id,
        }),
      },
    ]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ alert: 'engine_command_rejected', seq: '1' }),
    );
  } finally {
    errorLog.mockRestore();
  }
});

it('halts on a persistent sequence gap and preserves that state across restart', async () => {
  const token = await register();
  await restart({
    ENGINE_WORKER_ENABLED: false,
    ORDER_SYNC_WAIT_MS: 10,
    SEQ_GAP_ALERT_MS: 30,
    COMMAND_POLL_INTERVAL_MS: 10,
  });
  const { order } = await (await submit(token)).json();
  await database().query('DELETE FROM order_commands WHERE seq=1');
  await submit(token);
  await restart({ SEQ_GAP_ALERT_MS: 30, COMMAND_POLL_INTERVAL_MS: 10 });
  await waitFor(
    async () =>
      (await database().query("SELECT status FROM instrument_state WHERE instrument='ABC'"))[0]
        .status === 'halted',
  );
  expect((await submit(token)).status).toBe(503);
  const cancel = await request(`/orders/${order.id}`, 'DELETE', token);
  expect(cancel.status).toBe(503);
  expect(await cancel.json()).toMatchObject({ code: 'INSTRUMENT_HALTED' });
  await restart();
  expect((await submit(token)).status).toBe(503);
  expect(
    await database().query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'"),
  ).toEqual([{ last_applied_seq: '0' }]);
});

it('halts on a recovery mismatch instead of serving an empty replacement book', async () => {
  const owner = await register();
  await submit(owner);
  await database().query("UPDATE instrument_state SET resting_count=999 WHERE instrument='ABC'");
  await restart();
  const response = await submit(owner);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'INSTRUMENT_HALTED' });
  expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
    asks: [{ quantity: '1.00000000' }],
  });
});

it('rejects a failed reservation without issuing a sequence number', async () => {
  await restart({}, (builder) =>
    builder.overrideProvider(ReservationClient).useValue({ reserve: async () => 'rejected' }),
  );
  const owner = await register();
  const body = { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 };
  const headers = { 'Idempotency-Key': 'rejected' };
  const response = await request('/orders', 'POST', owner, body, headers);
  expect(response.status).toBe(422);
  const rejected = await response.json();
  const repeated = await request('/orders', 'POST', owner, body, headers);
  expect(repeated.status).toBe(422);
  expect(await repeated.json()).toEqual(rejected);
  expect(await database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([
    { next_seq: '0' },
  ]);
  expect(await database().query('SELECT status FROM order_requests')).toEqual([
    { status: 'rejected' },
  ]);
});

it('cancels a resting order while settlement holds every reservation request', async () => {
  let hang = false;
  const held: ((result: 'accepted') => void)[] = [];
  await restart({}, (builder) =>
    builder.overrideProvider(ReservationClient).useValue({
      reserve: () =>
        hang ? new Promise((resolve) => held.push(resolve)) : Promise.resolve('accepted'),
    }),
  );
  const owner = await register();
  const { order } = await (await submit(owner)).json();
  hang = true;
  const stuck = Array.from({ length: 8 }, (_, index) =>
    request(
      '/orders',
      'POST',
      owner,
      { instrument: 'ABC', side: 'sell', price: 101, quantity: 1 },
      {
        'Idempotency-Key': `stuck-${index}`,
      },
    ),
  );
  await waitFor(async () => held.length === 5);

  const started = performance.now();
  const cancelled = await request(`/orders/${order.id}`, 'DELETE', owner);
  expect(cancelled.status).toBe(200);
  expect((await cancelled.json()).order.status).toBe('cancelled');
  expect(performance.now() - started).toBeLessThan(2000);
  // Межа прийому не зросла: до settlement дійшло не більше п'яти запитів.
  expect(held).toHaveLength(5);

  hang = false;
  for (const release of held) release('accepted');
  const statuses = await Promise.all(stuck.map(async (response) => (await response).status));
  expect(statuses.every((status) => status === 201 || status === 202)).toBe(true);
  expect(await database().query('SELECT count(*)::int AS n FROM orders WHERE price=101')).toEqual([
    { n: 8 },
  ]);
});

it('returns service unavailable for Redis failure while allowing cancellation', async () => {
  const owner = await register();
  const { order } = await (await submit(owner)).json();
  const limiter = app().get(RateLimits) as unknown as {
    storage: { increment(): Promise<unknown> };
  };
  const failure = jest
    .spyOn(limiter.storage, 'increment')
    .mockRejectedValue(new Error('Redis offline'));
  try {
    expect((await submit(owner)).status).toBe(503);
    expect((await request(`/orders/${order.id}`, 'DELETE', owner)).status).toBe(200);
  } finally {
    failure.mockRestore();
  }
});

it('maps a lost PostgreSQL connection to a retryable service response', async () => {
  const owner = await register();
  const failure = jest
    .spyOn(database().manager, 'query')
    .mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
  try {
    expect((await submit(owner)).status).toBe(503);
  } finally {
    failure.mockRestore();
  }
  expect(await database().query('SELECT count(*)::int AS n FROM order_commands')).toEqual([
    { n: 0 },
  ]);
});
