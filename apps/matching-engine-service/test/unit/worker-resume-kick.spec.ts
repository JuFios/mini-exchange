import { InstrumentWorker } from '../../src/engine/instrument-worker';

function setup() {
  const config = { getOrThrow: (key: string) => (key === 'ENGINE_WORKER_ENABLED' ? true : 100) };
  const notifications = {
    resumeListeners: new Set(),
    commandListeners: new Set(),
    ackResume: jest.fn(async () => undefined),
    answerResume: jest.fn(async () => undefined),
  };
  const ownership = { leases: { beforeShutdown: new Set(), lost: new Set(), valid: () => true } };
  const worker = new InstrumentWorker(
    {} as never,
    config as never,
    { list: () => [{ symbol: 'ABC' }] } as never,
    ownership as never,
    {} as never,
    notifications as never,
    {} as never,
  );
  const owned = worker['owned'] as Map<string, object>;
  owned.set('ABC', { lease: {}, book: {}, seq: '0', halted: false });
  let finishInstall!: () => void;
  const installed = new Promise<void>((resolve) => (finishInstall = resolve));
  jest.spyOn(worker as never, 'install').mockImplementation((async () => {
    await installed;
    return { halted: false };
  }) as never);
  const drain = jest
    .spyOn(worker as unknown as { drain: () => Promise<void> }, 'drain')
    .mockResolvedValue(undefined);
  jest
    .spyOn(worker as never, 'bounded')
    .mockImplementation(
      ((_instrument: string, _lease: unknown, work: Promise<void>) => work) as never,
    );
  const resume = worker['resume'] as (request: { instrument: string; id: string }) => void;
  return { worker, drain, finishInstall, resume, notifications };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

it('drains a command that arrived during resume without waiting for the next poll', async () => {
  const { worker, drain, finishInstall, resume, notifications } = setup();
  resume({ instrument: 'ABC', id: 'r1' });
  await settle();
  // Заявка прийшла, поки resume ще відновлює книгу: kick лише позначає інструмент.
  void worker.kick('ABC');
  expect(drain).not.toHaveBeenCalled();

  finishInstall();
  await settle();
  await settle();
  expect(notifications.answerResume).toHaveBeenCalledWith('r1', true);
  expect(drain).toHaveBeenCalledTimes(1);
});

it('drains the backlog of the halt right after a resume without a new command', async () => {
  const { drain, finishInstall, resume } = setup();
  resume({ instrument: 'ABC', id: 'r2' });
  finishInstall();
  await settle();
  await settle();
  expect(drain).toHaveBeenCalledTimes(1);
});
