import { AuthService } from '../../src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrivateGateway, userRoom } from '../../src/realtime/private.gateway';
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
