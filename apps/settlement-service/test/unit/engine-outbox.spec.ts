import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { EngineOutboxClient } from '../../src/consumer/engine-outbox.client';
import { InvalidEventError } from '../../src/consumer/settlement-event';
import { SettlementEventHandler } from '../../src/consumer/settlement-event.handler';
import { SettlementStats } from '../../src/consumer/settlement-stats';

const token = 'outbox-read-token-value-000000000001';
const client = () =>
  new EngineOutboxClient(
    new ConfigService({ ENGINE_INTERNAL_URL: 'http://engine', OUTBOX_READ_TOKEN: token }),
  );
afterEach(() => jest.restoreAllMocks());

it('uses only the event ID from an untrusted Redis envelope', async () => {
  const eventId = randomUUID();
  const canonical = {
    position: '7',
    envelope: JSON.stringify({
      eventId,
      producer: 'matching-engine',
      type: 'order.closed',
      version: 1,
      payload: {
        orderId: randomUUID(),
        userId: randomUUID(),
        releasedAsset: 'ABC',
        releasedAmount: '1',
      },
    }),
  };
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(canonical)));
  const release = jest.fn().mockResolvedValue({ status: 'released' });
  const handler = new SettlementEventHandler(
    {} as never,
    { release, closedRelease: async () => undefined } as never,
    {} as never,
    {} as never,
    new SettlementStats(),
    client(),
    {} as never,
  );
  await handler.handle(
    '1-0',
    JSON.stringify({ eventId, payload: { releasedAmount: '9999999999' } }),
  );
  expect(fetcher.mock.calls[0][0].toString()).toBe(
    `http://engine/internal/outbox/events/${eventId}`,
  );
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({ 'x-internal-token': token });
  expect(release.mock.calls[0][1]).toBe(1n);
});

it('fails closed for missing, uncommitted and unavailable event sources', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch');
  await expect(client().event('{}')).rejects.toBeInstanceOf(InvalidEventError);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 404 }));
  await expect(client().event(JSON.stringify({ eventId: randomUUID() }))).rejects.toBeInstanceOf(
    InvalidEventError,
  );
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }));
  await expect(client().event(JSON.stringify({ eventId: randomUUID() }))).rejects.toMatchObject({
    status: 503,
  });
});

it('replays a committed prefix after failure between financial commit and progress', async () => {
  const applied = new Set<string>();
  let fail = true;
  let progress = '0';
  const source = {
    query: async (sql: string, args: string[]) => {
      if (sql.startsWith('SELECT')) return progress === '0' ? [] : [{ position: progress }];
      if (fail) {
        fail = false;
        throw new Error('Process interrupted after financial COMMIT');
      }
      progress = args[1];
      return [];
    },
  };
  const outbox = {
    page: async (instrument: string, after: string) =>
      instrument === 'ABC' && after === '0'
        ? [
            { position: '1', envelope: 'first' },
            { position: '2', envelope: 'second' },
          ]
        : [],
  };
  const handler = new SettlementEventHandler(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new SettlementStats(),
    outbox as never,
    source as never,
  );
  const attempts: string[] = [];
  jest.spyOn(handler, 'handle').mockImplementation(async (_, event) => {
    attempts.push(event!);
    applied.add(event!);
  });
  await expect(handler.recover(() => false)).rejects.toThrow('interrupted');
  expect(progress).toBe('0');
  await handler.recover(() => false);
  expect(progress).toBe('2');
  expect(attempts).toEqual(['first', 'first', 'second']);
  expect([...applied]).toEqual(['first', 'second']);
});
