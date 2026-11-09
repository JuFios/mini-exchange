import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as Engine from '../../src/contracts/events';
import type * as Settlement from '../../../settlement-service/src/contracts/events';
import { outboxStreamFields } from '../../src/outbox/streams';

type SameShape<A, B> = [A, B] extends [B, A] ? true : false;
type EngineContract = [Engine.Envelope<unknown>, Engine.EngineEvent, Engine.WalletUpdatedV1];
type SettlementContract = [
  Settlement.Envelope<unknown>,
  Settlement.EngineEvent,
  Settlement.WalletUpdatedV1,
];

type Fixtures = {
  [Event in Engine.EngineEvent as Event['type']]: Engine.Envelope<Event['payload']>;
} & { 'wallet.updated': Settlement.Envelope<Settlement.WalletUpdatedV1> };

const fixtures: Fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/events-v1.json'), 'utf8'),
);

it('keeps the v1 event contract compatible between engine and settlement', () => {
  const sameShape: SameShape<EngineContract, SettlementContract> = true;
  expect(sameShape).toBe(true);
  expect(fixtures['wallet.updated']).toMatchObject({
    type: 'wallet.updated',
    version: 1,
    producer: 'settlement',
    payload: { version: '9007199254740994' },
  });
  expect(fixtures['wallet.updated']).not.toHaveProperty('seq');
});

it.each(Object.values(fixtures).filter(({ producer }) => producer === 'matching-engine'))(
  'serializes the $type v1 fixture without changing its JSON fields',
  (fixture) => {
    const fields = outboxStreamFields({
      event_id: fixture.eventId,
      type: fixture.type,
      version: fixture.version,
      instrument: fixture.instrument ?? null,
      seq: fixture.seq ?? null,
      payload: fixture.payload,
      traceparent: fixture.traceparent ?? null,
      created_at: new Date(fixture.occurredAt),
    });
    expect(fields.slice(0, -2)).toEqual([
      'eventId',
      fixture.eventId,
      'type',
      fixture.type,
      'version',
      '1',
      'instrument',
      'ABC',
      'seq',
      '9007199254740993',
      'traceparent',
      fixture.traceparent ?? '',
    ]);
    expect(fields.at(-2)).toBe('envelope');
    expect(JSON.parse(fields.at(-1)!)).toEqual(fixture);
  },
);
