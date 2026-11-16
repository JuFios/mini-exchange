import { MigrationInterface, QueryRunner } from 'typeorm';

export class LiveOrdersIndex1793980800008 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE INDEX orders_live_id_idx ON orders (id) INCLUDE (owner_id, instrument, created_at)
      WHERE status IN ('open', 'partially_filled')`);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query('DROP INDEX orders_live_id_idx');
  }
}
