import { ConfigService } from '@nestjs/config';
import { ChaosHooks } from '../../src/chaos/chaos-hooks';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';

const client = {
  on: jest.fn(),
  disconnect: jest.fn(),
  info: jest.fn(),
  xinfo: jest.fn().mockResolvedValue([]),
  xrevrange: jest.fn().mockResolvedValue([]),
  xread: jest.fn(),
};
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => client) }));

const started: RealtimeStreamReader[] = [];
afterEach(() => Promise.all(started.splice(0).map((reader) => reader.onModuleDestroy())));

async function startReader(clusterEnabled: 0 | 1) {
  client.info.mockResolvedValue(`# Cluster\r\ncluster_enabled:${clusterEnabled}\r\n`);
  client.xread.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(null), 5)),
  );
  const reader = new RealtimeStreamReader(
    { getOrThrow: (key: string) => (key === 'REDIS_PORT' ? 6379 : 'redis') } as ConfigService,
    { list: () => [{ symbol: 'ABC' }] } as unknown as InstrumentCatalog,
    { readerFrozen: false } as ChaosHooks,
  );
  started.push(reader);
  reader.onApplicationBootstrap();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return reader;
}

describe('a stream reader pointed at a Redis Cluster node', () => {
  it('never becomes ready, so the replica refuses WebSocket clients', async () => {
    const reader = await startReader(1);
    expect(reader.ready).toBe(false);
    expect(client.xread).not.toHaveBeenCalled();
  });

  it('becomes ready on a standalone Redis', async () => {
    const reader = await startReader(0);
    expect(reader.ready).toBe(true);
  });
});
