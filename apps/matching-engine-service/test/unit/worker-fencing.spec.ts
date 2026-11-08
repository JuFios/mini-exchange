import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { FencedOutError } from '../../src/ownership/fencing';
import type { InstrumentLease } from '../../src/ownership/lease-manager';

function lease(active: boolean, value = 'v'): InstrumentLease {
  return { instrument: 'ABC', key: 'k', value, renewedAt: 0, active };
}

function setup() {
  const dropped: InstrumentLease[] = [];
  const ownership = {
    fencedWrites: 0,
    leases: { drop: (item: InstrumentLease) => dropped.push(item) },
  };
  const worker = new InstrumentWorker(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    ownership as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const owned = worker['owned'] as Map<string, { lease: InstrumentLease }>;
  return { worker, owned, ownership, dropped };
}

it('drops the lease of the fenced drain, not a lease acquired while it was running', async () => {
  const { worker, owned, ownership, dropped } = setup();
  const stale = lease(true, 'stale');
  const fresh = lease(true, 'fresh');
  owned.set('ABC', { lease: stale });
  jest
    .spyOn(worker as unknown as { drain: () => Promise<void> }, 'drain')
    .mockImplementation(async () => {
      // Поки старий drain чекав на БД, lease змінився й recovery поставив нову книгу.
      owned.set('ABC', { lease: fresh });
      throw new FencedOutError();
    });
  await worker.kick('ABC');
  expect(dropped.map(({ value }) => value)).toEqual(['stale']);
  expect(ownership.fencedWrites).toBe(1);
});

it('does not count a locally expired lease as a fenced write', async () => {
  const { worker, owned, ownership } = setup();
  owned.set('ABC', { lease: lease(false) });
  jest
    .spyOn(worker as unknown as { drain: () => Promise<void> }, 'drain')
    .mockRejectedValue(new FencedOutError());
  await worker.kick('ABC');
  expect(ownership.fencedWrites).toBe(0);
});
