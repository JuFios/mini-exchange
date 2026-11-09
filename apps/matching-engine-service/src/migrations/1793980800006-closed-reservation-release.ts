import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClosedReservationRelease1793980800006 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      ALTER TABLE outbox
        ADD COLUMN reservation_release_due_at timestamptz,
        ADD COLUMN reservation_released_at timestamptz;
      CREATE INDEX outbox_reservation_release_idx
        ON outbox (COALESCE(reservation_release_due_at, created_at), id)
        WHERE type='order.closed' AND reservation_released_at IS NULL;
    `);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query(`
      DROP INDEX outbox_reservation_release_idx;
      ALTER TABLE outbox
        DROP COLUMN reservation_release_due_at,
        DROP COLUMN reservation_released_at;
    `);
  }
}
