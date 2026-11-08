import { ConfigService } from '@nestjs/config';
import { LeaseManager } from '../../src/ownership/lease-manager';

jest.mock('../../src/locks/redis-lock.service', () => ({
  RedisLockService: jest.fn().mockImplementation(() => ({
    acquire: jest.fn(async () => true),
    renew: jest.fn(),
    release: jest.fn(async () => 1),
    onModuleDestroy: jest.fn(async () => undefined),
  })),
}));

it('steps down at its monotonic deadline and ignores a late successful renewal', async () => {
  jest.useFakeTimers();
  const values: Record<string, string | number> = {
    INSTANCE_ID: 'owner',
    LEASE_TTL_MS: 5000,
    LEASE_SAFETY_MS: 500,
    LEASE_RENEW_INTERVAL_MS: 1500,
    ACQUIRE_INTERVAL_MS: 1000,
  };
  const manager = new LeaseManager({
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService);
  let renewed!: (result: number) => void;
  jest.mocked(manager.locks.renew).mockImplementation(
    () =>
      new Promise((resolve) => {
        renewed = resolve;
      }),
  );
  const lost: string[] = [];
  manager.lost.add((instrument) => lost.push(instrument));
  try {
    const lease = (await manager.acquire('ABC'))!;
    await jest.advanceTimersByTimeAsync(1500);
    expect(manager.locks.renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(manager.valid(lease)).toBe(false);
    expect(lost).toEqual(['ABC']);
    renewed(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.leases.has('ABC')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(manager.locks.release).toHaveBeenCalledWith(lease.key, lease.value);
  } finally {
    await manager.onModuleDestroy();
    jest.useRealTimers();
  }
});

it('leaves the lease to another replica during the back-off after a stall', async () => {
  jest.useFakeTimers();
  const values: Record<string, string | number> = {
    INSTANCE_ID: 'owner',
    LEASE_TTL_MS: 5000,
    LEASE_SAFETY_MS: 500,
    LEASE_RENEW_INTERVAL_MS: 1500,
    ACQUIRE_INTERVAL_MS: 1000,
  };
  const manager = new LeaseManager({
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService);
  jest.mocked(manager.locks.acquire).mockClear();
  jest.mocked(manager.locks.renew).mockResolvedValue(1);
  try {
    const lease = (await manager.acquire('ABC'))!;
    await jest.advanceTimersByTimeAsync(2000);
    manager.drop(lease, 5000);
    await jest.advanceTimersByTimeAsync(4999);
    expect(await manager.acquire('ABC')).toBeUndefined();
    expect(manager.locks.acquire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await manager.acquire('ABC')).toBeDefined();
    expect(manager.locks.acquire).toHaveBeenCalledTimes(2);
  } finally {
    await manager.onModuleDestroy();
    jest.useRealTimers();
  }
});
