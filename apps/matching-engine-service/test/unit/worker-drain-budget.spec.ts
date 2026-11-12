import { InstrumentWorker } from '../../src/engine/instrument-worker';

afterEach(() => jest.useRealTimers());

it('stops a drain pass when its time budget is spent so resume and shutdown do not wait for it', async () => {
  jest.useFakeTimers();
  let applied = 0;
  const owned = { epoch: '1', lease: {}, book: {}, seq: '0', halted: false };
  const source = {
    query: async () => [{ seq: String(Number(owned.seq) + 1), next_seq: '1000' }],
    // Кожна команда триває 300 мс.
    transaction: async () => {
      applied++;
      jest.advanceTimersByTime(300);
      return { book: {}, trades: [] };
    },
  };
  const worker = new InstrumentWorker(
    source as never,
    { getOrThrow: () => 1000 } as never,
    {} as never,
    { leases: { assert: () => undefined } } as never,
    { reach: async () => undefined } as never,
    {} as never,
    {} as never,
  );
  (worker['owned'] as Map<string, unknown>).set('ABC', owned);

  await (worker as unknown as { drain: (instrument: string) => Promise<void> }).drain('ABC');

  // Бюджет 1 с: команди 0, 300, 600, 900 мс, п’ята вже не стартує.
  expect(applied).toBe(4);
});

it('drains again at once when a command is announced during the last read of a pass', async () => {
  const owned = { epoch: '1', lease: { active: true }, book: {}, seq: '0', halted: false };
  let finishRead!: () => void;
  let reads = 0;
  const source = {
    // Перше читання ще не бачить команди; її NOTIFY приходить, поки воно триває.
    query: async () => {
      if (++reads === 1) await new Promise<void>((resolve) => (finishRead = resolve));
      return [{ seq: null, next_seq: '0' }];
    },
  };
  const worker = new InstrumentWorker(
    source as never,
    { getOrThrow: () => 1000 } as never,
    {} as never,
    { leases: { assert: () => undefined } } as never,
    { reach: async () => undefined } as never,
    {} as never,
    {} as never,
  );
  (worker['owned'] as Map<string, unknown>).set('ABC', owned);
  const running = worker['running'] as Map<string, Promise<void>>;

  const first = worker.kick('ABC');
  await Promise.resolve();
  const announced = worker.kick('ABC');
  expect(reads).toBe(1);
  finishRead();
  await Promise.all([first, announced]);
  await running.get('ABC');

  expect(reads).toBe(2);
  // Без нового сповіщення третього проходу немає.
  await new Promise((resolve) => setImmediate(resolve));
  expect(reads).toBe(2);
  expect(running.size).toBe(0);
});
