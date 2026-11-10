import fc from 'fast-check';
import { LagTracker, RecentIds, streamPosition } from '../../src/realtime/replica-lag';

describe('LagTracker', () => {
  const max = 5000;
  const validFor = 4000;

  it('stays healthy while the replica is caught up', () => {
    const tracker = new LagTracker(max, validFor, 0);
    for (let now = 0; now <= 60_000; now += 2000)
      expect(tracker.check(10n, 10n, now)).toEqual({ lag: 0n, stale: false });
  });

  it('does not call a replica stale while it keeps advancing behind a busy relay', () => {
    const tracker = new LagTracker(max, validFor, 0);
    for (let step = 0; step < 30; step++) {
      // Relay завжди на 3 команди попереду, але репліка просувається на кожному тіку.
      const result = tracker.check(BigInt(step * 10 + 3), BigInt(step * 10), step * 2000);
      expect(result).toEqual({ lag: 3n, stale: false });
    }
  });

  it('turns stale once the replica is behind and makes no progress for longer than the limit', () => {
    const tracker = new LagTracker(max, validFor, 0);
    expect(tracker.check(10n, 10n, 0).stale).toBe(false);
    expect(tracker.check(15n, 10n, 1000).stale).toBe(false);
    expect(tracker.check(15n, 10n, 6000).stale).toBe(false);
    expect(tracker.check(15n, 10n, 6001)).toEqual({ lag: 5n, stale: true });
  });

  it('keeps the last verdict while a check fails, but only for as long as it is valid', () => {
    const tracker = new LagTracker(max, validFor, 0);
    expect(tracker.isStale(0)).toBe(false);
    tracker.check(20n, 10n, 1000);
    tracker.check(20n, 10n, 7000);
    expect(tracker.isStale(7000)).toBe(true);
    expect(tracker.check(20n, 20n, 8000).stale).toBe(false);
    expect(tracker.isStale(8000)).toBe(false);
    // Проби більше не вдаються: чинний вердикт «здорова» спливає.
    expect(tracker.isStale(12_000)).toBe(false);
    expect(tracker.isStale(12_001)).toBe(true);
  });

  it('expires a replica whose first check never succeeded', () => {
    const tracker = new LagTracker(max, validFor, 1000);
    expect(tracker.isStale(5000)).toBe(false);
    expect(tracker.isStale(5001)).toBe(true);
  });

  it('becomes valid again with the next successful check', () => {
    const tracker = new LagTracker(max, validFor, 0);
    expect(tracker.isStale(10_000)).toBe(true);
    tracker.check(5n, 5n, 10_000);
    expect(tracker.isStale(10_000)).toBe(false);
  });

  it('recovers as soon as the replica catches up or advances', () => {
    const tracker = new LagTracker(max, validFor, 0);
    tracker.check(20n, 10n, 0);
    expect(tracker.check(20n, 10n, 9000).stale).toBe(true);
    expect(tracker.check(20n, 11n, 10_000).stale).toBe(false);
    expect(tracker.check(20n, 20n, 20_000)).toEqual({ lag: 0n, stale: false });
    expect(tracker.check(30n, 20n, 24_000).stale).toBe(false);
  });
});

describe('LagTracker validity invariant', () => {
  it('is stale exactly when the last check is old or the last successful verdict was a stall', () => {
    const step = fc.record({
      checks: fc.boolean(),
      gap: fc.integer({ min: 0, max: 3 }),
      dt: fc.integer({ min: 1, max: 6000 }),
    });
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 9000 }),
        fc.integer({ min: 1, max: 9000 }),
        (steps, max, validFor) => {
          const tracker = new LagTracker(max, validFor, 0);
          let now = 0;
          let checkedAt = 0;
          let lagStale = false;
          for (const { checks, gap, dt } of steps) {
            now += dt;
            if (checks) {
              lagStale = tracker.check(BigInt(gap), 0n, now).stale;
              checkedAt = now;
            }
            expect(tracker.isStale(now)).toBe(lagStale || now - checkedAt > validFor);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('LagTracker invariants', () => {
  /** Незалежна модель: хвіст перевірок з ненульовим відставанням і незмінним `emitted`. */
  function modelStale(
    history: { published: bigint; emitted: bigint; now: number }[],
    maxLagMs: number,
  ): boolean {
    const last = history[history.length - 1];
    let first = last;
    for (let i = history.length - 1; i >= 0; i--) {
      const step = history[i];
      if (step.published <= step.emitted || step.emitted !== last.emitted) break;
      first = step;
    }
    return last.published > last.emitted && last.now - first.now > maxLagMs;
  }

  it('reports a stall exactly when a lagging replica has not advanced for longer than the limit', () => {
    const step = fc.record({
      gap: fc.integer({ min: 0, max: 3 }),
      advance: fc.integer({ min: 0, max: 2 }),
      dt: fc.integer({ min: 1, max: 4000 }),
    });
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 9000 }),
        (steps, max) => {
          const tracker = // Строк придатності тут не перевіряється: лише вердикт за відставанням.
            new LagTracker(max, Number.MAX_SAFE_INTEGER, 0);
          const history: { published: bigint; emitted: bigint; now: number }[] = [];
          let emitted = 0n;
          let now = 0;
          for (const { gap, advance, dt } of steps) {
            emitted += BigInt(advance);
            now += dt;
            const published = emitted + BigInt(gap);
            history.push({ published, emitted, now });
            const result = tracker.check(published, emitted, now);
            expect(result.lag).toBe(BigInt(gap));
            expect(result.stale).toBe(modelStale(history, max));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('RecentIds', () => {
  it('reports a repeated ID only once and forgets the oldest beyond its capacity', () => {
    const ids = new RecentIds(2);
    expect(ids.add('a')).toBe(true);
    expect(ids.add('a')).toBe(false);
    expect(ids.add('b')).toBe(true);
    expect(ids.add('c')).toBe(true);
    expect(ids.add('b')).toBe(false);
    expect(ids.add('a')).toBe(true);
  });
});

describe('streamPosition', () => {
  it('orders positions exactly as Redis orders entry IDs', () => {
    const id = fc.tuple(fc.nat(2 ** 40), fc.nat(2 ** 20));
    fc.assert(
      fc.property(id, id, ([msA, seqA], [msB, seqB]) => {
        const redisOrder = msA - msB || seqA - seqB;
        const a = streamPosition(`${msA}-${seqA}`);
        const b = streamPosition(`${msB}-${seqB}`);
        expect(a < b).toBe(redisOrder < 0);
        expect(a === b).toBe(redisOrder === 0);
      }),
    );
  });

  it.each(['', '0', 'abc', '1-', '-1', '1-2-3'])('reads %j as the start of the stream', (id) => {
    expect(streamPosition(id)).toBe(0n);
  });
});
