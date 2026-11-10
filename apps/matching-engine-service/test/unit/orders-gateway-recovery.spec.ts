import fc from 'fast-check';
import { buildLegacyGateway, FakeSocket } from '../helpers/fake-legacy-gateway';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('legacy book push after a failed read', () => {
  it('retries and delivers the book without another command', async () => {
    let failNext = false;
    const env = buildLegacyGateway(() => {
      const failed = failNext;
      failNext = false;
      return failed;
    });
    const socket = env.socket();
    const call = env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(200);
    await call;
    env.state.reads = 0;

    failNext = true;
    env.change();
    await jest.advanceTimersByTimeAsync(5000);

    expect(socket.connected).toBe(true);
    expect(socket.received.at(-1)).toBe(1);
  });

  it('closes the room once the retries are used up, with a bounded number of reads', async () => {
    let broken = false;
    const env = buildLegacyGateway(() => broken);
    const socket = env.socket();
    const call = env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(200);
    await call;
    env.state.reads = 0;

    broken = true;
    env.change();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(socket.connected).toBe(false);
    expect(env.state.closedRooms).toBe(1);
    // Перша спроба і три повтори.
    expect(env.state.reads).toBe(4);
  });

  it('pushes a fresh book after a market stream gap, when no delta will announce the change', async () => {
    const env = buildLegacyGateway();
    const socket = env.socket();
    const call = env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(200);
    await call;

    env.changeWithoutDelta();
    env.gap('exchange:market:{ABC}');
    await jest.advanceTimersByTimeAsync(1000);

    expect(socket.received.at(-1)).toBe(env.state.version);
  });

  it('pushes only the instrument whose market stream had the gap', async () => {
    const env = buildLegacyGateway();
    const abc = env.socket();
    const xyz = env.socket();
    const calls = [
      env.gateway.subscribe(abc as never, 'ABC'),
      env.gateway.subscribe(xyz as never, 'XYZ'),
    ];
    await jest.advanceTimersByTimeAsync(300);
    await Promise.all(calls);
    const [abcBefore, xyzBefore] = [abc.received.length, xyz.received.length];

    env.changeWithoutDelta();
    env.gap('exchange:market:{XYZ}');
    await jest.advanceTimersByTimeAsync(1000);

    expect(xyz.received.length).toBe(xyzBefore + 1);
    expect(abc.received.length).toBe(abcBefore);
  });

  it.each(['exchange:user-events', 'exchange:market:{ZZZ}', 'something else'])(
    'does not read the book for a gap of %s',
    async (stream) => {
      const env = buildLegacyGateway();
      const socket = env.socket();
      const call = env.gateway.subscribe(socket as never, 'ABC');
      await jest.advanceTimersByTimeAsync(200);
      await call;
      env.state.reads = 0;

      env.gap(stream);
      await jest.advanceTimersByTimeAsync(1000);

      expect(env.state.reads).toBe(0);
    },
  );

  it('counts failures within one episode, not over the life of the process', async () => {
    let plan: boolean[] = [];
    const env = buildLegacyGateway(() => plan.shift() ?? false);
    const socket = env.socket();
    const call = env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(200);
    await call;

    // Три епізоди по дві невдачі, кожен завершується вдалою розсилкою.
    for (let episode = 0; episode < 3; episode++) {
      plan = [true, true];
      env.change();
      await jest.advanceTimersByTimeAsync(5000);
    }

    expect(socket.connected).toBe(true);
    expect(env.state.closedRooms).toBe(0);
    expect(socket.received.at(-1)).toBe(env.state.version);
  });

  it('never leaves a connected subscriber on a stale book, whatever fails', async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('subscribe' as const), n: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ kind: fc.constant('change' as const), n: fc.constant(0) }),
      fc.record({ kind: fc.constant('wait' as const), n: fc.integer({ min: 1, max: 700 }) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 30 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        async (ops, pattern) => {
          jest.useFakeTimers();
          let reads = 0;
          const env = buildLegacyGateway(() => pattern[reads++ % pattern.length]);
          const sockets = Array.from({ length: 3 }, () => env.socket());
          const confirmed = new Set<FakeSocket>();
          for (const { kind, n } of ops) {
            if (kind === 'subscribe') {
              const socket = sockets[n];
              if (socket.connected)
                void env.gateway.subscribe(socket as never, 'ABC').then((ack) => {
                  if (ack === undefined) confirmed.add(socket);
                });
            } else if (kind === 'change') env.change();
            else await jest.advanceTimersByTimeAsync(n);
          }
          await jest.advanceTimersByTimeAsync(20_000);

          for (const socket of sockets) {
            // Клієнт, якому підписку підтверджено, або бачить свіжу книгу, або вже розірваний
            // і перепідключиться. Застарілою назавжди вона лишатися не може.
            if (socket.connected && confirmed.has(socket))
              expect(socket.received.at(-1)).toBe(env.state.version);
          }
          jest.useRealTimers();
        },
      ),
      { numRuns: 150 },
    );
  });
});
