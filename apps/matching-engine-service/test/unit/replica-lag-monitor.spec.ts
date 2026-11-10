import { ConfigService } from '@nestjs/config';
import fc from 'fast-check';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { HEARTBEAT_INTERVAL_MS, ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

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

  it('is healthy again as soon as one probe succeeds', async () => {
    const { reader, monitor } = build(5000);
    await run(HEARTBEAT_INTERVAL_MS);
    reader.probeFails = true;
    await run(10_000);
    expect(monitor.healthy()).toBe(false);

    reader.probeFails = false;
    await run(HEARTBEAT_INTERVAL_MS);
    expect(monitor.healthy()).toBe(true);
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
  /** Модель: репліка здорова, поки остання успішна проба (або перший тік) не старша за вікно. */
  it('holds exactly while the last successful probe is not older than the validity window', async () => {
    const step = fc.record({
      probeOk: fc.boolean(),
      pgOk: fc.boolean(),
      dt: fc.integer({ min: 100, max: 7000 }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 9000 }),
        async (steps, maxLagMs) => {
          jest.useFakeTimers();
          const { reader, source, monitor } = build(maxLagMs);
          const window = Math.max(maxLagMs, 2 * HEARTBEAT_INTERVAL_MS);
          let now = 0;
          let firstTick: number | undefined;
          let lastOk: number | undefined;
          for (const { probeOk, pgOk, dt } of steps) {
            reader.probeFails = !probeOk;
            if (pgOk) source.query.mockResolvedValue([]);
            else source.query.mockRejectedValue(new Error('down'));
            const end = now + dt;
            for (
              let tick = (Math.floor(now / HEARTBEAT_INTERVAL_MS) + 1) * HEARTBEAT_INTERVAL_MS;
              tick <= end;
              tick += HEARTBEAT_INTERVAL_MS
            ) {
              firstTick ??= tick;
              if (probeOk) lastOk = tick;
            }
            await run(dt);
            now = end;
            const reference = lastOk ?? firstTick;
            const expected = reference === undefined || now - reference <= window;
            expect(monitor.healthy()).toBe(expected);
          }
          monitor.onModuleDestroy();
          jest.useRealTimers();
        },
      ),
      { numRuns: 60 },
    );
  });
});
