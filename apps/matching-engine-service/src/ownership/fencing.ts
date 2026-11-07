import { EntityManager } from 'typeorm';

export class FencedOutError extends Error {
  constructor() {
    super('Instrument ownership was fenced out');
  }
}

export function assertEpoch(actual: string, expected: string): void {
  if (actual !== expected) throw new FencedOutError();
}

export async function lockEpoch(db: EntityManager, instrument: string, epoch: string) {
  await db.query("SET LOCAL lock_timeout='3s'");
  const [state] = await db.query('SELECT * FROM instrument_state WHERE instrument=$1 FOR UPDATE', [
    instrument,
  ]);
  assertEpoch(state.owner_epoch, epoch);
  return state;
}
