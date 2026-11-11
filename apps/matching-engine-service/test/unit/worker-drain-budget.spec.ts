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
    { commit: () => undefined } as never,
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
