import type { Socket } from 'socket.io';
import { refuseWhileStale } from '../../src/realtime/replica-guard';
import type { ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

const monitor = (healthy: boolean) => ({ healthy: () => healthy }) as ReplicaLagMonitor;

describe('refuseWhileStale', () => {
  it('lets a connection through while the replica is healthy', () => {
    const next = jest.fn();
    refuseWhileStale(monitor(true))({} as Socket, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses a connection that got past the upgrade check once the replica turned stale', () => {
    const next = jest.fn();
    refuseWhileStale(monitor(false))({} as Socket, next);
    expect(next).toHaveBeenCalledWith(new Error('REPLICA_UNAVAILABLE'));
  });
});
