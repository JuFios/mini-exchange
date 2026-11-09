import type { EngineEvent, Envelope } from '../contracts/events';

export const marketStream = (instrument: string): string => `exchange:market:{${instrument}}`;
export const settlementStream = (instrument: string): string =>
  `exchange:settlement:{${instrument}}`;
export const USER_EVENTS_STREAM = 'exchange:user-events';

export function streamForEvent(type: EngineEvent['type'], instrument: string): string {
  switch (type) {
    case 'book.delta':
    case 'trade.public':
      return marketStream(instrument);
    case 'trade.executed':
    case 'order.closed':
      return settlementStream(instrument);
    case 'order.updated':
      return USER_EVENTS_STREAM;
  }
}

export interface OutboxStreamRow {
  event_id: string;
  type: string;
  version: number;
  instrument: string | null;
  seq: string | null;
  payload: unknown;
  traceparent: string | null;
  created_at: Date;
}

export function outboxStreamFields(row: OutboxStreamRow): string[] {
  // Relay передає збережену версію, щоб формат визначав виробник події.
  const envelope: Omit<Envelope<unknown>, 'version'> & { version: number } = {
    eventId: row.event_id,
    type: row.type,
    version: row.version,
    ...(row.instrument !== null && { instrument: row.instrument }),
    ...(row.seq !== null && { seq: row.seq }),
    occurredAt: row.created_at.toISOString(),
    producer: 'matching-engine',
    ...(row.traceparent !== null && { traceparent: row.traceparent }),
    payload: row.payload,
  };
  return [
    'eventId',
    row.event_id,
    'type',
    row.type,
    'version',
    String(row.version),
    'instrument',
    row.instrument ?? '',
    'seq',
    row.seq ?? '',
    'traceparent',
    row.traceparent ?? '',
    'envelope',
    JSON.stringify(envelope),
  ];
}
