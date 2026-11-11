import fc from 'fast-check';
import { buildLegacyGateway, FakeSocket } from '../helpers/fake-legacy-gateway';

const build = () => buildLegacyGateway();

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('legacy subscriptions', () => {
  it('holds for any mix of subscribes, disconnects and book changes', async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('subscribe' as const), who: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ kind: fc.constant('disconnect' as const), who: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ kind: fc.constant('change' as const), who: fc.constant(0) }),
      fc.record({ kind: fc.constant('wait' as const), who: fc.integer({ min: 1, max: 120 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
        jest.useFakeTimers();
        const env = build();
        const sockets = Array.from({ length: 4 }, () => env.socket());
        // Версія книги на момент останньої підписки: після неї сокет має отримати не старішу.
        const subscribedAt = new Map<FakeSocket, number>();
        let subscribes = 0;
        let changes = 0;
        for (const { kind, who } of ops) {
          const socket = sockets[who % 4];
          if (kind === 'subscribe') {
            if (socket.connected) {
              subscribes++;
              subscribedAt.set(socket, env.state.version);
              void env.gateway.subscribe(socket as never, 'ABC');
            }
          } else if (kind === 'disconnect') socket.disconnect();
          else if (kind === 'change') {
            changes++;
            env.change();
          } else await jest.advanceTimersByTimeAsync(who);
        }
        await jest.advanceTimersByTimeAsync(2000);

        for (const socket of sockets) {
          // Книга одного сокета ніколи не відкочується до старішої версії.
          expect(socket.received).toEqual([...socket.received].sort((a, b) => a - b));
          const since = subscribedAt.get(socket);
          // Той, хто лишився підключеним, отримав книгу не старішу за свою підписку.
          if (socket.connected && since !== undefined)
            expect(Math.max(...socket.received, -1)).toBeGreaterThanOrEqual(since);
        }
        // Читань не більше, ніж викликів, що їх спричиняють, а за схлопування часто менше.
        expect(env.state.reads).toBeLessThanOrEqual(subscribes + changes);
        jest.useRealTimers();
      }),
      { numRuns: 150 },
    );
  });

  it('answers a thousand repeated subscribes of one socket with at most two reads', async () => {
    const env = build();
    const socket = env.socket();
    const calls = Array.from({ length: 1000 }, () => env.gateway.subscribe(socket as never, 'ABC'));
    await jest.advanceTimersByTimeAsync(500);
    await Promise.all(calls);
    expect(env.state.reads).toBeLessThanOrEqual(2);
    expect(socket.received).toHaveLength(1);
  });

  it('does not read the book for a batch whose sockets have all gone', async () => {
    const env = build();
    const first = env.socket();
    const second = env.socket();
    const firstCall = env.gateway.subscribe(first as never, 'ABC');
    await jest.advanceTimersByTimeAsync(10);
    // Читання для першого ще триває, друга пачка чекає в черзі.
    const secondCall = env.gateway.subscribe(second as never, 'ABC');
    second.disconnect();
    await jest.advanceTimersByTimeAsync(500);
    await Promise.all([firstCall, secondCall]);

    expect(env.state.reads).toBe(1);
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(0);
  });

  it('refuses overlap on the same socket before reading and releases the slot after failure', async () => {
    let fail = true;
    const env = buildLegacyGateway(() => fail);
    const socket = env.socket();
    const peer = env.socket();
    const first = env.gateway.subscribe(socket as never, 'ABC');
    const parallel = env.gateway.subscribe(peer as never, 'ABC');
    const rejected = jest.fn();
    void env.gateway.subscribe(socket as never, 'XYZ').then(rejected);
    await jest.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledWith({ ok: false, error: 'Підписка вже виконується' });
    expect(env.rooms.has('XYZ')).toBe(false);
    expect(env.state.reads).toBe(1);

    await jest.advanceTimersByTimeAsync(50);
    const unavailable = { ok: false, error: 'Книга тимчасово недоступна' };
    await expect(Promise.all([first, parallel])).resolves.toEqual([unavailable, unavailable]);
    fail = false;
    const retry = env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(50);
    await expect(retry).resolves.toBeUndefined();
    expect(socket.received).toHaveLength(1);
    expect(env.state.reads).toBe(2);
  });

  it('does not accept a subscribe from a socket that has already gone', async () => {
    const env = build();
    const socket = env.socket();
    socket.disconnect();
    await env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(500);
    expect(env.state.reads).toBe(0);
    expect(env.rooms.get('ABC')?.size ?? 0).toBe(0);
  });
});
