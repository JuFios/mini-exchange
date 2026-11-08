import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { FencedOutError } from '../../src/ownership/fencing';
import type { InstrumentLease } from '../../src/ownership/lease-manager';

afterEach(() => jest.useRealTimers());

const STALL_MS = 30000;
const never = () => new Promise<never>(() => undefined);

function lease(value = 'v'): InstrumentLease {
  return { instrument: 'ABC', key: 'k', value, renewedAt: 0, active: true };
}

function setup(recover: () => Promise<unknown> = never, source: object = {}, applier: object = {}) {
  jest.useFakeTimers();
  const held = lease();
  const dropped: [InstrumentLease, number | undefined][] = [];
  const logged: unknown[] = [];
  const ownership = {
    fencedWrites: 0,
    recover,
    leases: {
      acquire: async () => held,
      assert: () => undefined,
      drop: (item: InstrumentLease, backOff?: number) => {
        if (!item.active) return;
        item.active = false;
        dropped.push([item, backOff]);
      },
    },
  };
  const worker = new InstrumentWorker(
    source as never,
    { getOrThrow: () => 1000 } as never,
    {} as never,
    { commit: () => undefined, quarantine: () => undefined } as never,
    {} as never,
    ownership as never,
    { reach: async () => undefined } as never,
    {} as never,
    applier as never,
  );
  jest.spyOn(worker['logger'], 'error').mockImplementation((message) => {
    logged.push(message);
  });
  jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
  const owned = worker['owned'] as Map<string, object>;
  return { worker, owned, held, dropped, logged, ownership };
}

const drain = (worker: InstrumentWorker) =>
  jest.spyOn(worker as unknown as { drain: () => Promise<void> }, 'drain');

it('releases the lease with a back-off when a drain never settles', async () => {
  const { worker, owned, held, dropped, logged } = setup();
  owned.set('ABC', { lease: held });
  drain(worker).mockImplementation(never);

  const kicked = worker.kick('ABC');
  await jest.advanceTimersByTimeAsync(STALL_MS - 1);
  expect(dropped).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  await kicked;

  expect(dropped).toEqual([[held, 5000]]);
  expect(worker['running'].has('ABC')).toBe(false);
  expect(logged).toContainEqual({ alert: 'engine_worker_stalled', instrument: 'ABC' });
});

it('releases the lease and frees the slot when recovery never settles', async () => {
  const { worker, held, dropped, owned } = setup();

  const loading = worker['reload']('ABC');
  const failure = expect(loading).rejects.toBeInstanceOf(FencedOutError);
  await jest.advanceTimersByTimeAsync(STALL_MS);
  await failure;

  expect(dropped[0]).toEqual([held, 5000]);
  expect(worker['loading'].has('ABC')).toBe(false);
  expect(owned.has('ABC')).toBe(false);
});

it('does not install a recovery that finishes after the stall', async () => {
  let finish!: (value: unknown) => void;
  const { worker, owned } = setup(() => new Promise((resolve) => (finish = resolve)));

  const failure = expect(worker['reload']('ABC')).rejects.toBeInstanceOf(FencedOutError);
  await jest.advanceTimersByTimeAsync(STALL_MS);
  await failure;
  finish({ book: { bids: [], asks: [] }, seq: '0', halted: false, lease: lease('late') });
  await jest.advanceTimersByTimeAsync(0);

  expect(owned.has('ABC')).toBe(false);
});

it('stops a stale drain once a new lease owns the instrument', async () => {
  let reply!: (rows: object[]) => void;
  const transaction = jest.fn();
  const source = {
    query: () => new Promise((resolve) => (reply = resolve)),
    transaction,
  };
  const { worker, owned, held } = setup(never, source);
  owned.set('ABC', { lease: held, seq: '0', halted: false, book: {} });

  const stale = (worker as unknown as { drain: (s: string) => Promise<void> }).drain('ABC');
  await jest.advanceTimersByTimeAsync(0);
  // Сторожовий таймер звільнив запис, і ця ж репліка отримала новий lease.
  owned.set('ABC', { lease: lease('fresh'), seq: '0', halted: false, book: {} });
  reply([{ seq: '1', next_seq: '1' }]);
  await stale;

  expect(transaction).not.toHaveBeenCalled();
});

it('leaves the lease alone when the drain finishes in time', async () => {
  const { worker, owned, held, dropped } = setup();
  owned.set('ABC', { lease: held });
  drain(worker).mockResolvedValue(undefined);

  await worker.kick('ABC');
  await jest.advanceTimersByTimeAsync(STALL_MS * 2);

  expect(dropped).toEqual([]);
});

it('keeps the lease while a long drain keeps making progress', async () => {
  const { worker, owned, held, dropped } = setup();
  owned.set('ABC', { lease: held });
  let finish!: () => void;
  drain(worker).mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));

  const kicked = worker.kick('ABC');
  for (let step = 0; step < 4; step++) {
    await jest.advanceTimersByTimeAsync(20000);
    worker['beat'](held);
  }
  finish();
  await kicked;

  expect(dropped).toEqual([]);
});

it('releases the lease once progress stops part way through', async () => {
  const { worker, owned, held, dropped } = setup();
  owned.set('ABC', { lease: held });
  drain(worker).mockImplementation(never);

  const kicked = worker.kick('ABC');
  await jest.advanceTimersByTimeAsync(20000);
  worker['beat'](held);
  await jest.advanceTimersByTimeAsync(STALL_MS - 1);
  expect(dropped).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  await kicked;

  expect(dropped).toEqual([[held, 5000]]);
});

function sweep(makers: number) {
  const updates: string[] = [];
  const target = {
    id: 'taker',
    ownerId: 'u',
    side: 'buy',
    price: '100.00',
    quantity: '5.00000000',
    remainingQuantity: '5.00000000',
    prioritySeq: '1',
    status: 'pending',
    version: 0,
  };
  const orders = {
    findOneByOrFail: async () => target,
    update: async ({ id }: { id: string }) => {
      updates.push(id);
      return { affected: 1 };
    },
  };
  const db = {
    query: async (sql: string) =>
      sql.includes('FOR UPDATE')
        ? [
            {
              owner_epoch: '1',
              status: 'active',
              legacy_verified: true,
              last_applied_seq: '0',
            },
          ]
        : [[], 1],
    getRepository: () => orders,
  };
  const applier = {
    apply: () => ({
      outcome: 'accepted',
      book: { bids: [], asks: [] },
      trades: [],
      levelChanges: [],
      closed: [],
      orderChanges: Array.from({ length: makers }, (_, index) => ({
        id: `maker-${index}`,
        status: 'filled',
        remaining: 0n,
        quantity: 1n,
      })),
    }),
  };
  const row = {
    instrument: 'ABC',
    seq: '1',
    type: 'submit',
    order_id: 'taker',
    accepted_at: new Date(0),
    traceparent: null,
  };
  return { db, row, updates, applier };
}

it('reports progress for every maker of one large command', async () => {
  const { db, row, applier } = sweep(5);
  const { worker, held } = setup(never, {}, applier);
  const beat = jest.spyOn(worker as unknown as { beat: () => void }, 'beat');

  await worker['applyOne'](
    db as never,
    { lease: held, seq: '0', epoch: '1', book: {} } as never,
    row as never,
  );

  expect(beat.mock.calls.length).toBeGreaterThanOrEqual(5);
});

it('abandons a large command as soon as its lease is gone', async () => {
  const { db, row, updates, applier } = sweep(5);
  const { worker, held, ownership } = setup(never, {}, applier);
  let checks = 0;
  ownership.leases.assert = () => {
    if (++checks > 3) throw new FencedOutError();
  };

  await expect(
    worker['applyOne'](
      db as never,
      { lease: held, seq: '0', epoch: '1', book: {} } as never,
      row as never,
    ),
  ).rejects.toBeInstanceOf(FencedOutError);

  expect(updates.length).toBeLessThan(5);
});

it('locks intake before halting on a sequence gap', async () => {
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('FOR UPDATE') ? [{ owner_epoch: '1' }] : [];
    },
  };
  const source = {
    query: async () => [{ seq: '5', next_seq: '5' }],
    transaction: async (work: (manager: unknown) => Promise<unknown>) => work(db),
  };
  const { worker, owned, held } = setup(never, source);
  (worker['config'] as unknown as { getOrThrow: () => number }).getOrThrow = () => 0;
  owned.set('ABC', { lease: held, seq: '0', epoch: '1', halted: false, book: {} });

  await (worker as unknown as { drain: (s: string) => Promise<void> }).drain('ABC');

  const lock = queries.findIndex((sql) => /FROM instruments .*FOR UPDATE/.test(sql));
  const halt = queries.findIndex((sql) => sql.includes("SET status='halted'"));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(lock).toBeLessThan(halt);
});
