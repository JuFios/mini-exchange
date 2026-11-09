import type { EntityManager } from 'typeorm';
import type { EngineEvent } from '../contracts/events';
import type { CommandRow } from '../engine/command';
import { streamForEvent } from './streams';

export async function insertOutboxEvents(
  db: EntityManager,
  row: CommandRow,
  events: EngineEvent[],
): Promise<void> {
  const records = events.map((event) => ({
    ...event,
    stream: streamForEvent(event.type, row.instrument),
  }));
  await db.query(
    `INSERT INTO outbox (event_id, stream, type, version, instrument, seq, payload, traceparent)
     SELECT gen_random_uuid(), event->>'stream', event->>'type', 1, $1, $2, event->'payload', $3
     FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS batch(event, position)
     ORDER BY position`,
    [row.instrument, row.seq, row.traceparent, JSON.stringify(records)],
  );
}
