import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReservationReleaseClaims1793980800005 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      ALTER TABLE order_requests ADD COLUMN release_due_at timestamptz;
      CREATE INDEX order_requests_release_due_idx ON order_requests (release_due_at)
        WHERE status='releasing';
    `);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query(`
      DROP INDEX order_requests_release_due_idx;
      ALTER TABLE order_requests DROP COLUMN release_due_at;
    `);
  }
}
