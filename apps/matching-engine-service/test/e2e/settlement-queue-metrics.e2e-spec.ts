import Redis from 'ioredis';
import { OutboxRelay } from '../../src/outbox/outbox-relay.service';
import { settlementStream } from '../../src/outbox/streams';
import { engineApp } from './engine-app';

// Engine читає чергу settlement сам, тож сигнал відставання лишається, коли settlement не працює.
const api = engineApp();
const abc = settlementStream('ABC');
const xyz = settlementStream('XYZ');
let redis: Redis;

beforeAll(() => {
  redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
    maxRetriesPerRequest: 0,
  });
});

afterAll(async () => {
  await redis.del(abc, xyz);
  redis.disconnect();
});

const gauges = async () => {
  const response = await api.request('/metrics');
  expect(response.status).toBe(200);
  return Object.fromEntries(
    (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('engine_settlement_'))
      .map((line) => [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)]),
  );
};
const key = (name: string, stream: string) => `engine_settlement_${name}{stream="${stream}"}`;
// prom-client пише NaN як `Nan`; Prometheus читає його без урахування регістру.
const unknown = expect.stringMatching(/^nan$/i);

it('reports settlement stream length, pending entries and lag read from Redis', async () => {
  await redis.del(abc, xyz);
  for (const id of ['1-1', '2-1', '3-1']) await redis.xadd(abc, id, 'type', 'trade.executed');
  await redis.xgroup('CREATE', abc, 'settlement', '0');
  await redis.xreadgroup('GROUP', 'settlement', 'probe', 'COUNT', 1, 'STREAMS', abc, '>');
  await redis.xadd(xyz, '1-1', 'type', 'trade.executed');

  expect(await gauges()).toMatchObject({
    [key('stream_length', abc)]: '3',
    [key('group_pending', abc)]: '1',
    [key('group_lag', abc)]: '2',
    // Групи немає: settlement ще не запускався, тож скільки він не прочитав, невідомо.
    [key('stream_length', xyz)]: '1',
    [key('group_pending', xyz)]: unknown,
    [key('group_lag', xyz)]: unknown,
  });

  // Видалений недоставлений запис: Redis повертає lag null, а не нуль.
  await redis.xdel(abc, '2-1');
  expect(await gauges()).toMatchObject({
    [key('stream_length', abc)]: '2',
    [key('group_pending', abc)]: '1',
    [key('group_lag', abc)]: unknown,
  });
});

it('reports the settlement queue as unknown without waiting when Redis is unavailable', async () => {
  // Той самий клієнт, яким relay публікує події: окремого з'єднання для метрик немає.
  const client = api.app().get(OutboxRelay)['redis'];
  client.disconnect();
  try {
    const started = performance.now();
    const values = await gauges();
    expect(performance.now() - started).toBeLessThan(2000);
    for (const stream of [abc, xyz])
      for (const name of ['stream_length', 'group_pending', 'group_lag'])
        expect(values[key(name, stream)]).toEqual(unknown);
  } finally {
    await client.connect();
  }
});
