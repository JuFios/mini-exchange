import { InstrumentWorker } from '../../src/engine/instrument-worker';

afterEach(() => jest.useRealTimers());

function setup() {
  const acquired: string[] = [];
  const ownership = {
    leases: {
      beforeShutdown: new Set(),
      lost: new Set(),
      // Вільного lease немає: кожен poll має знову спробувати захопити інструмент.
      acquire: async (instrument: string) => {
        acquired.push(instrument);
        return undefined;
      },
    },
  };
  const config = {
    getOrThrow: (key: string) => (key === 'ENGINE_WORKER_ENABLED' ? true : 100),
  };
  const notifications = { resumeListeners: new Set(), commandListeners: new Set() };
  const worker = new InstrumentWorker(
    {} as never,
    config as never,
    { list: () => [{ symbol: 'ABC' }, { symbol: 'XYZ' }] } as never,
    {} as never,
    ownership as never,
    {} as never,
    notifications as never,
    {} as never,
  );
  return { worker, acquired };
}

it('keeps trying to acquire a free instrument while another one is draining a backlog', async () => {
  jest.useFakeTimers();
  const { worker, acquired } = setup();
  const owned = worker['owned'] as Map<string, object>;
  owned.set('ABC', { lease: {}, book: {}, seq: '0', halted: false });
  // Backlog ABC не завершується: drain має лишатися активним увесь тест.
  jest
    .spyOn(worker as unknown as { drain: () => Promise<void> }, 'drain')
    .mockImplementation(() => new Promise<never>(() => undefined));

  void worker.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(1000);

  // Інтервал poll 100 мс: за секунду XYZ має отримати кілька спроб, а не одну.
  expect(acquired.filter((instrument) => instrument === 'XYZ').length).toBeGreaterThanOrEqual(5);
  // Drain навмисно не завершується, тому shutdown не чекаємо.
  void worker.onModuleDestroy();
});

it('does not delay acquisition of one instrument while another one is still loading', async () => {
  jest.useFakeTimers();
  const { worker, acquired } = setup();
  const leases = (worker['ownership'] as { leases: { acquire: (s: string) => Promise<undefined> } })
    .leases;
  leases.acquire = async (instrument: string) => {
    acquired.push(instrument);
    // Захоплення ABC зависає (повільний Redis): XYZ усе одно має повторюватися.
    if (instrument === 'ABC') await new Promise<never>(() => undefined);
    return undefined;
  };

  void worker.onApplicationBootstrap();
  await jest.advanceTimersByTimeAsync(1000);

  expect(acquired.filter((instrument) => instrument === 'XYZ').length).toBeGreaterThanOrEqual(5);
  // Повторні poll не запускають друге завантаження ABC, поки перше триває.
  expect(acquired.filter((instrument) => instrument === 'ABC')).toHaveLength(1);
  void worker.onModuleDestroy();
});
