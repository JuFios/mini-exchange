import { DataSource } from 'typeorm';
import { CommittedBook } from '../../src/engine/committed-book';

function fakeSource(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const queries: string[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('FROM instrument_state'))
        return [{ last_applied_seq: '7', legacy_verified: true }];
      if (sql.includes('FROM orders')) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return [{ price: '100.00', quantity: '1.00000000', orders: 1, limit: params?.[2] }];
      }
      return [];
    },
  };
  const source = {
    transaction: async (_level: string, run: (db: unknown) => Promise<unknown>) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await run(db);
      } finally {
        inFlight--;
      }
    },
  } as unknown as DataSource;
  return { source, queries, peak: () => peak };
}

it('keeps public book reads from taking more than three pooled connections', async () => {
  const fake = fakeSource(20);
  const book = new CommittedBook(fake.source);
  const results = await Promise.all(Array.from({ length: 12 }, () => book.read('ABC')));
  expect(results).toHaveLength(12);
  expect(fake.peak()).toBeLessThanOrEqual(3);
});

it('sorts and limits levels in SQL and returns only the public fields', async () => {
  const fake = fakeSource(0);
  const result = await new CommittedBook(fake.source).read('ABC', 5);
  expect(result).toEqual({
    instrument: 'ABC',
    seq: '7',
    bids: [{ price: '100.00', quantity: '1.00000000', orders: 1 }],
    asks: [{ price: '100.00', quantity: '1.00000000', orders: 1 }],
  });
  const orderQueries = fake.queries.filter((sql) => sql.includes('FROM orders'));
  expect(orderQueries).toHaveLength(2);
  expect(orderQueries[0]).toContain('ORDER BY price DESC LIMIT');
  expect(orderQueries[1]).toContain('ORDER BY price ASC LIMIT');
});

it('releases the slot when a read fails', async () => {
  const failing = {
    transaction: async () => {
      throw new Error('database unavailable');
    },
  } as unknown as DataSource;
  const book = new CommittedBook(failing);
  for (let i = 0; i < 10; i++) await expect(book.read('ABC')).rejects.toThrow('unavailable');
});

it('refuses a public read of an instrument whose legacy state is unverified', async () => {
  const source = {
    transaction: async (_level: string, run: (db: unknown) => Promise<unknown>) =>
      run({
        query: async (sql: string) =>
          sql.includes('FROM instrument_state')
            ? [{ last_applied_seq: '7', legacy_verified: false }]
            : [],
      }),
  } as unknown as DataSource;
  await expect(new CommittedBook(source).read('ABC')).rejects.toMatchObject({
    status: 503,
    response: { code: 'INSTRUMENT_HALTED' },
  });
});

it('stops waiting for a slot after the queue deadline and leaves the queue', async () => {
  jest.useFakeTimers();
  try {
    const stuck = {
      transaction: () => new Promise<never>(() => undefined),
    } as unknown as DataSource;
    const book = new CommittedBook(stuck);
    for (let i = 0; i < 3; i++) void book.read('ABC');
    const queued = book.read('ABC');
    const outcome = expect(queued).rejects.toMatchObject({
      status: 503,
      response: { code: 'BOOK_BUSY' },
    });
    await jest.advanceTimersByTimeAsync(2500);
    await outcome;
    expect(book['waiting']).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
