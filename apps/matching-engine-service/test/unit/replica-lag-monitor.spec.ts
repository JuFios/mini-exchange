import { ConfigService } from '@nestjs/config';
import fc from 'fast-check';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { HEARTBEAT_INTERVAL_MS, ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

/** Скільки поспіль свіжих проб потрібно репліці, щоб повернутися в пул: три тіки. */
const RECOVER_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

const STREAMS = ['exchange:market:{ABC}', 'exchange:user-events'];

/** Читач з керованими пробами Redis: зсув позиції й відмови задає тест. */
class FakeReader {
  ready = true;
  streams = STREAMS;
  probeFails = false;
  probes = 0;
  heads = new Map<string, bigint>(STREAMS.map((stream) => [stream, 10n]));
  cursors = new Map<string, bigint>(STREAMS.map((stream) => [stream, 10n]));
  cursor(stream: string) {
    return this.cursors.get(stream)!;
  }
  emittedSeq() {
    return 0n;
  }
  head(stream: string) {
    this.probes++;
    return this.probeFails
      ? Promise.reject(new Error('probe timeout'))
      : Promise.resolve(this.heads.get(stream)!);
  }
}

function build(maxLagMs: number) {
  const reader = new FakeReader();
  const source = {
    query: jest.fn().mockResolvedValue([{ instrument: 'ABC', last_applied_seq: '5' }]),
  };
  const monitor = new ReplicaLagMonitor(
    { getOrThrow: () => maxLagMs } as unknown as ConfigService,
    source as never,
    reader as unknown as RealtimeStreamReader,
    { has: () => true } as unknown as InstrumentCatalog,
  );
  monitor.onApplicationBootstrap();
  return { reader, source, monitor };
}

const run = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('a replica that loses its stream probes', () => {
  it('stays healthy through a few missed probes, then leaves the pool and drops its sockets', async () => {
    const { reader, monitor } = build(5000);
    const stale = jest.fn();
    monitor.onStale(stale);
    await run(HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(true);

    reader.probeFails = true;
    await run(2 * HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(true);

    await run(3 * HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(false);
    expect(stale).toHaveBeenCalledTimes(1);
    monitor.onModuleDestroy();
  });

  it('stays out of the pool until probes have been fresh for the whole recovery period', async () => {
    const { reader, monitor } = build(5000);
    await run(HEARTBEAT_INTERVAL_MS);
    reader.probeFails = true;
    await run(10_000);
    expect(monitor.healthy()).toBe(false);

    reader.probeFails = false;
    await run(2 * HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(false);
    await run(2 * HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(true);
    monitor.onModuleDestroy();
  });

  it('does not count failed probes towards the recovery while the old verdict is still valid', async () => {
    const { reader, monitor } = build(5000);
    await run(HEARTBEAT_INTERVAL_MS);
    reader.probeFails = true;
    await run(10_000);
    expect(monitor.healthy()).toBe(false);

    // Дві успішні проби, далі Redis знову мовчить: кешований вердикт ще чинний, але докази відновлення немає.
    reader.probeFails = false;
    await run(2 * HEARTBEAT_INTERVAL_MS);
    reader.probeFails = true;
    for (let tick = 0; tick < 4; tick++) {
      await run(HEARTBEAT_INTERVAL_MS);
      expect(monitor.healthy()).toBe(false);
    }
    monitor.onModuleDestroy();
  });

  it('does not flap when probes succeed only now and then', async () => {
    const { reader, monitor } = build(5000);
    const stale = jest.fn();
    monitor.onStale(stale);
    await run(HEARTBEAT_INTERVAL_MS);
    // Шість тіків збою, один успішний: вердикт на межі вікна без гістерезису мигав би.
    let flips = 0;
    let last = monitor.healthy();
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let tick = 0; tick < 4; tick++) {
        reader.probeFails = tick < 3;
        for (let part = 0; part < 4; part++) {
          await run(HEARTBEAT_INTERVAL_MS / 4);
          if (monitor.healthy() !== last) flips++;
          last = monitor.healthy();
        }
      }
    }
    // Один перехід у `stale` на початку, далі репліка поза пулом.
    expect(flips).toBe(1);
    expect(monitor.healthy()).toBe(false);
    expect(stale).toHaveBeenCalledTimes(1);
    monitor.onModuleDestroy();
  });

  it('never trusts a probe that has not succeeded since the replica started', async () => {
    const { reader, monitor } = build(5000);
    reader.probeFails = true;
    await run(10_000);
    expect(monitor.healthy()).toBe(false);
    monitor.onModuleDestroy();
  });
});

describe('a PostgreSQL problem next to a working Redis', () => {
  it('does not stop the stream probes when the heartbeat query fails', async () => {
    const { reader, source, monitor } = build(5000);
    source.query.mockRejectedValue(new Error('connection refused'));
    await run(5 * HEARTBEAT_INTERVAL_MS);
    expect(reader.probes).toBeGreaterThanOrEqual(5 * STREAMS.length);
    monitor.onModuleDestroy();
  });

  it.each([
    ['fails', (query: jest.Mock) => query.mockRejectedValue(new Error('connection refused'))],
    ['hangs', (query: jest.Mock) => query.mockReturnValue(new Promise(() => undefined))],
  ])(
    'still detects a reader that stopped following the stream when the query %s',
    async (_name, break_) => {
      const { reader, source, monitor } = build(5000);
      await run(HEARTBEAT_INTERVAL_MS);
      break_(source.query);
      reader.heads.set(STREAMS[0], 15n);
      await run(10_000);
      expect(monitor.healthy()).toBe(false);
      monitor.onModuleDestroy();
    },
  );

  it('is not unhealthy only because PostgreSQL is down', async () => {
    const { source, monitor } = build(5000);
    source.query.mockRejectedValue(new Error('connection refused'));
    await run(60_000);
    expect(monitor.healthy()).toBe(true);
    monitor.onModuleDestroy();
  });

  it('stops reporting the lag while the heartbeat query fails instead of freezing the last value', async () => {
    const { source, monitor } = build(5000);
    await run(HEARTBEAT_INTERVAL_MS);
    expect(monitor.lag().get('ABC')).toBe(5n);

    source.query.mockRejectedValue(new Error('connection refused'));
    await run(2 * HEARTBEAT_INTERVAL_MS);
    expect(monitor.lag().size).toBe(0);
    monitor.onModuleDestroy();
  });

  it('keeps the lag metric when only a heartbeat handler throws', async () => {
    const { monitor } = build(5000);
    monitor.onHeartbeat(() => {
      throw new Error('emit failed');
    });
    await run(HEARTBEAT_INTERVAL_MS);
    // Запит вдався, тож різниця відома; збій відправки її не скасовує.
    expect(String(monitor.lag().get('ABC'))).toBe('5');
    await run(HEARTBEAT_INTERVAL_MS);
    expect(String(monitor.lag().get('ABC'))).toBe('5');
    monitor.onModuleDestroy();
  });

  it('keeps sending heartbeats while the stream probes fail', async () => {
    const { reader, monitor } = build(5000);
    const heartbeat = jest.fn();
    monitor.onHeartbeat(heartbeat);
    reader.probeFails = true;
    await run(5 * HEARTBEAT_INTERVAL_MS);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(heartbeat).toHaveBeenLastCalledWith('ABC', '5');
    monitor.onModuleDestroy();
  });
});

describe('health verdict invariant', () => {
  /**
   * Модель: «сире» вердикт завислості — остання успішна проба (або перший тік) старша за вікно.
   * Здорова репліка ніколи не зависла за сирим вердиктом, а після вікна відновлення без завислості
   * вона здорова завжди. Між цими межами рішення належить гістерезису.
   */
  it('is never healthy while stale and is healthy after a quiet recovery period', async () => {
    const step = fc.record({
      probeOk: fc.boolean(),
      pgOk: fc.boolean(),
      parts: fc.integer({ min: 1, max: 28 }),
    });
    const part = 250;
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 9000 }),
        async (steps, maxLagMs) => {
          jest.useFakeTimers();
          const { reader, source, monitor } = build(maxLagMs);
          const window = Math.max(maxLagMs, 2 * HEARTBEAT_INTERVAL_MS);
          let now = 0;
          let firstTick: number | undefined;
          let lastOk: number | undefined;
          let lastStale = Number.NEGATIVE_INFINITY;
          for (const { probeOk, pgOk, parts } of steps) {
            reader.probeFails = !probeOk;
            if (pgOk) source.query.mockResolvedValue([]);
            else source.query.mockRejectedValue(new Error('down'));
            for (let i = 0; i < parts; i++) {
              now += part;
              const isTick = now % HEARTBEAT_INTERVAL_MS === 0;
              // Завислість може настати саме на тіку, до того як його проба її перекриє.
              if (isTick && lastOk !== undefined && now - lastOk > window) lastStale = now;
              if (isTick && lastOk === undefined && firstTick !== undefined) {
                if (now - firstTick > window) lastStale = now;
              }
              if (isTick) {
                firstTick ??= now;
                if (probeOk) lastOk = now;
                // Невдала проба теж не доводить відновлення, навіть поки вердикт чинний.
                else lastStale = now;
              }
              await run(part);
              const reference = lastOk ?? firstTick;
              const stale = reference !== undefined && now - reference > window;
              if (stale) lastStale = now;
              const healthy = monitor.healthy();
              if (healthy) expect(stale).toBe(false);
              if (now - lastStale >= RECOVER_AFTER_MS + 2 * HEARTBEAT_INTERVAL_MS + part) {
                expect(healthy).toBe(true);
              }
            }
          }
          monitor.onModuleDestroy();
          jest.useRealTimers();
        },
      ),
      { numRuns: 25 },
    );
  });
});
