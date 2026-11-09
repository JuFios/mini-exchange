import type { Socket } from 'socket.io';
import type { ReplicaLagMonitor } from './replica-lag.monitor';

/**
 * Завислу репліку знімають з ротації, але LB бачить лише успішний upgrade. Тому нове
 * підключення до неї відхиляється на рівні Socket.IO, і клієнт повторює спробу пізніше.
 */
export function refuseWhileStale(monitor: ReplicaLagMonitor) {
  return (_socket: Socket, next: (error?: Error) => void): void =>
    monitor.healthy() ? next() : next(new Error('REPLICA_UNAVAILABLE'));
}
