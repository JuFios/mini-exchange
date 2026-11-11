import { AuthService } from '../../src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  PrivateGateway,
  SESSION_CHECK_DEADLINE_MS,
  SESSION_CHECK_MS,
  SESSION_UNVERIFIED_MS,
  userRoom,
} from '../../src/realtime/private.gateway';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';
import type { UserEvent } from '../../src/realtime/realtime-events';

const sessions = { isSessionActive: async () => true } as unknown as AuthService;
const USER = 'c703e0f9-758a-45e8-a7a8-cdd4483dc4eb';
const event: UserEvent = {
  type: 'wallet.updated',
  eventId: 'e1',
  payload: {
    userId: USER,
    asset: 'USD',
    available: '90',
    reserved: '10',
    version: '7',
    entryId: 'x',
  },
};

function build(emit: () => void) {
  let onUser: (event: UserEvent) => void = () => undefined;
  const disconnect = jest.fn();
  const rooms: string[] = [];
  const server = {
    use: jest.fn(),
    to: () => ({ emit }),
    in: (room: string) => {
      rooms.push(room);
      return { disconnectSockets: disconnect };
    },
    disconnectSockets: jest.fn(),
  };
  const gateway = new PrivateGateway(
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
    {} as JwtService,
    {
      onUser: (handler: typeof onUser) => {
        onUser = handler;
        return () => undefined;
      },
      onGap: () => () => undefined,
    } as unknown as RealtimeStreamReader,
    { onStale: () => () => undefined } as unknown as ReplicaLagMonitor,
    sessions,
  );
  gateway.afterInit(server as never);
  return { deliver: () => onUser(event), disconnect, rooms };
}

describe('a private update that cannot be delivered', () => {
  it('closes the sockets of that user so that the client reads its state again', () => {
    const env = build(() => {
      throw new Error('socket buffer failure');
    });
    expect(() => env.deliver()).not.toThrow();
    expect(env.rooms).toEqual([userRoom(USER)]);
    expect(env.disconnect).toHaveBeenCalledWith(false);
  });

  it('leaves the sockets alone when the update is delivered', () => {
    const env = build(() => undefined);
    env.deliver();
    expect(env.disconnect).not.toHaveBeenCalled();
  });
});

describe('a private handshake that is still verifying when the replica turns stale', () => {
  it('is refused instead of staying connected to a replica that was just taken out', async () => {
    const middlewares: ((socket: unknown, next: (error?: Error) => void) => unknown)[] = [];
    let healthy = true;
    const gateway = new PrivateGateway(
      { getOrThrow: () => 'secret' } as unknown as ConfigService,
      {
        // Токен перевіряється асинхронно: за цей час репліка встигає стати завислою.
        verifyAsync: async () => {
          healthy = false;
          return {
            typ: 'access',
            sub: USER,
            sid: USER,
            email: 'a@example.test',
            exp: 4_102_444_800,
          };
        },
      } as unknown as JwtService,
      {
        onUser: () => () => undefined,
        onGap: () => () => undefined,
      } as unknown as RealtimeStreamReader,
      { healthy: () => healthy, onStale: () => () => undefined } as unknown as ReplicaLagMonitor,
      sessions,
    );
    gateway.afterInit({ use: (middleware: never) => middlewares.push(middleware) } as never);

    const errors: (Error | undefined)[] = [];
    const socket = { handshake: { auth: { token: 'token' } }, data: {} };
    // Охорону пройдено, поки репліка ще здорова.
    middlewares[0](socket, (error) => errors.push(error));
    void middlewares[1](socket, (error) => errors.push(error));
    // Проміжне ПЗ повертає керування до завершення перевірки токена.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors[0]).toBeUndefined();
    expect(errors[1]?.message).toBe('REPLICA_UNAVAILABLE');
  });
});

describe('private sockets whose session cannot be confirmed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function sessionsGateway(activeSessions: AuthService['activeSessions']) {
    const sockets = new Map<string, unknown>();
    const gateway = new PrivateGateway(
      { getOrThrow: () => 'secret' } as unknown as ConfigService,
      {} as JwtService,
      {
        onUser: () => () => undefined,
        onGap: () => () => undefined,
      } as unknown as RealtimeStreamReader,
      { onStale: () => () => undefined } as unknown as ReplicaLagMonitor,
      { activeSessions } as unknown as AuthService,
    );
    gateway.afterInit({ use: jest.fn(), sockets } as never);
    const connect = (sid: string) => {
      const socket = {
        connected: true,
        data: { userId: USER, sid, exp: 4_102_444_800, verifiedAt: performance.now() },
        disconnect: jest.fn(() => {
          socket.connected = false;
          sockets.delete(sid);
        }),
      };
      sockets.set(sid, socket);
      return socket;
    };
    return { gateway, connect };
  }

  it('closes them once the database stays unavailable past the bound', async () => {
    for (const failure of ['error', 'hang'] as const) {
      const env = sessionsGateway(
        failure === 'error'
          ? async () => {
              throw new Error('database is down');
            }
          : () => new Promise(() => undefined),
      );
      const socket = env.connect('6f0b0c5e-1f3c-4c39-9a52-0d1a3bfc2f10');
      await jest.advanceTimersByTimeAsync(SESSION_UNVERIFIED_MS - 1);
      expect(socket.disconnect).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(SESSION_CHECK_MS + 1);
      expect(socket.disconnect).toHaveBeenCalled();
      env.gateway.onModuleDestroy();
    }
  });

  it('abandons a stuck check at its deadline so later checks keep confirming sessions', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const env = sessionsGateway(async (sessions, signal) => {
      signals.push(signal);
      // Перший запит висить на мертвому TCP і сигнал скасування ігнорує.
      if (++calls === 1) return new Promise(() => undefined);
      return new Set(sessions.map(({ userId, sid }) => `${userId}:${sid}`));
    });
    const first = env.connect('6f0b0c5e-1f3c-4c39-9a52-0d1a3bfc2f10');
    await jest.advanceTimersByTimeAsync(SESSION_CHECK_MS + SESSION_CHECK_DEADLINE_MS);
    expect(signals[0].aborted).toBe(true);
    const later = env.connect('0d2f6a4e-7c1b-4a8e-9f3d-5b6c7d8e9f01');
    await jest.advanceTimersByTimeAsync(10 * SESSION_UNVERIFIED_MS);
    expect(calls).toBeGreaterThan(1);
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(later.disconnect).not.toHaveBeenCalled();
    env.gateway.onModuleDestroy();
  });

  it('keeps a confirmed session open and closes a revoked one at the next check', async () => {
    const kept = '0d2f6a4e-7c1b-4a8e-9f3d-5b6c7d8e9f01';
    const env = sessionsGateway(async () => new Set([`${USER}:${kept}`]));
    const confirmed = env.connect(kept);
    const revoked = env.connect('1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d');
    await jest.advanceTimersByTimeAsync(SESSION_CHECK_MS);
    expect(revoked.disconnect).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10 * SESSION_UNVERIFIED_MS);
    expect(confirmed.disconnect).not.toHaveBeenCalled();
    env.gateway.onModuleDestroy();
  });
});
