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

function manager() {
  const values: Record<string, string | number> = {
    INSTANCE_ID: 'owner',
    LEASE_TTL_MS: 5000,
    LEASE_SAFETY_MS: 500,
    LEASE_RENEW_INTERVAL_MS: 1500,
    ACQUIRE_INTERVAL_MS: 1000,
  };
  return new LeaseManager({ getOrThrow: (key: string) => values[key] } as unknown as ConfigService);
}

it('releases a lock whose SET reply may have been lost', async () => {
  const leases = manager();
  jest.mocked(leases.locks.acquire).mockRejectedValueOnce(new Error('Command timed out'));
  try {
    expect(await leases.acquire('ABC')).toBeUndefined();
    expect(leases.locks.release).toHaveBeenCalledTimes(1);
    const [key, value] = jest.mocked(leases.locks.release).mock.calls[0];
    expect(key).toBe('lease:instrument:{ABC}');
    expect(value).toMatch(/^owner:/);
  } finally {
    await leases.onModuleDestroy();
  }
});

it('schedules the next renewal from the start of a slow failed attempt', async () => {
  jest.useFakeTimers();
  const leases = manager();
  jest.mocked(leases.locks.renew).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Command timed out')), 1000);
      }),
  );
  try {
    await leases.acquire('ABC');
    await jest.advanceTimersByTimeAsync(1500);
    expect(leases.locks.renew).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1500);
    expect(leases.locks.renew).toHaveBeenCalledTimes(2);
  } finally {
    await leases.onModuleDestroy();
    jest.useRealTimers();
  }
});
