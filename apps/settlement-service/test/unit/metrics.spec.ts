import { MetricsController } from '../../src/consumer/metrics.controller';
import type { SettlementConsumer } from '../../src/consumer/settlement-consumer.service';
import { SettlementStats } from '../../src/consumer/settlement-stats';

type Queue = Awaited<ReturnType<SettlementConsumer['queue']>>;

const queue = (streams: { pending: number; lag: number | null }[]): Queue => ({
  group: 'settlement',
  consumer: 'settlement-1',
  streams: streams.map((stream, index) => ({
    stream: `exchange:settlement:{S${index}}`,
    length: 10,
    oldestPendingAgeSeconds: 120,
    lastDeliveredId: null,
    ...stream,
  })),
  deadLetters: 0,
  failures: 0,
});

const metric = async (value: Queue, name: string) => {
  const consumer = { queue: () => Promise.resolve(value) } as unknown as SettlementConsumer;
  const text = await new MetricsController(new SettlementStats(), consumer).metrics();
  return text.split('\n').find((line) => line.startsWith(`${name} `));
};

it('sums the stream lag when Redis knows it for every stream', async () => {
  const value = queue([
    { pending: 1, lag: 2 },
    { pending: 0, lag: 3 },
  ]);
  expect(await metric(value, 'settlement_stream_lag')).toBe('settlement_stream_lag 5');
  expect(await metric(value, 'settlement_pending')).toBe('settlement_pending 1');
  expect(await metric(value, 'settlement_oldest_pending_age_seconds')).toBe(
    'settlement_oldest_pending_age_seconds 120',
  );
});

it('reports an unknown stream lag instead of counting it as zero', async () => {
  // Redis повертає lag null, коли не може його обчислити, наприклад після видалення
  // недоставленого запису. Нуль ховав би саме відставання.
  const value = queue([
    { pending: 1, lag: null },
    { pending: 0, lag: 3 },
  ]);
  // prom-client пише `Nan`; Prometheus читає NaN без урахування регістру.
  expect(await metric(value, 'settlement_stream_lag')).toMatch(/^settlement_stream_lag nan$/i);
});
