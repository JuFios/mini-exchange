import { ConfigService } from '@nestjs/config';
import { ChaosHooks } from '../../src/chaos/chaos-hooks';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => ({ on: jest.fn(), disconnect: jest.fn() })),
}));

afterEach(() => jest.useRealTimers());

it('keeps logging stream failures after the system clock moves back', () => {
  jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') });
  const reader = new RealtimeStreamReader(
    { getOrThrow: (key: string) => (key === 'REDIS_PORT' ? 6379 : 'redis') } as ConfigService,
    { list: () => [] } as unknown as InstrumentCatalog,
    { readerFrozen: false } as ChaosHooks,
  );
  const logged = jest.spyOn(reader['logger'], 'error').mockImplementation(() => undefined);
  const fail = () => reader['logFailure'](new Error('Redis is unavailable'));

  fail();
  fail();
  expect(logged).toHaveBeenCalledTimes(1);
  jest.setSystemTime(Date.parse('2026-11-11T11:00:00.000Z'));
  jest.advanceTimersByTime(5000);
  fail();
  expect(logged).toHaveBeenCalledTimes(2);
});
