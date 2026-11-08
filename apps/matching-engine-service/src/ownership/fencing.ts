import { EntityManager } from 'typeorm';

export class FencedOutError extends Error {
  constructor() {
    super('Instrument ownership was fenced out');
  }
}

export function assertEpoch(actual: string, expected: string): void {
  if (actual !== expected) throw new FencedOutError();
}

// Intake спершу бере рядок лічильника, а статус читає вже після цього. Той самий рядок тут
// означає, що транзакції intake або завершились до halt, або побачать його.
export async function haltInstrument(db: EntityManager, instrument: string): Promise<void> {
  await db.query('SELECT 1 FROM instruments WHERE symbol=$1 FOR UPDATE', [instrument]);
  await db.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [instrument]);
}

export async function lockEpoch(db: EntityManager, instrument: string, epoch: string) {
  await db.query("SET LOCAL lock_timeout='3s'");
  const [state] = await db.query('SELECT * FROM instrument_state WHERE instrument=$1 FOR UPDATE', [
    instrument,
  ]);
  assertEpoch(state.owner_epoch, epoch);
  return state;
}
