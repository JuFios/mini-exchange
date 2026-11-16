import { MigrationInterface, QueryRunner } from 'typeorm';

export class SettlementProgress1793980800001 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE settlement_progress (
      instrument text PRIMARY KEY, position bigint NOT NULL DEFAULT 0 CHECK(position>=0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query('DROP TABLE settlement_progress');
  }
}
