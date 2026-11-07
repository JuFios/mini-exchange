import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuarantineLegacyState1793980800004 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Snapshot із БД старого matcher не доводить залишок maker: старий код його не оновлював.
    await runner.query(`ALTER TABLE instrument_state ADD COLUMN legacy_verified boolean NOT NULL DEFAULT true;
      UPDATE order_commands SET result=result || '{"status":"unverified_snapshot"}'::jsonb
      WHERE result->>'status'='imported_snapshot';
      UPDATE instrument_state s SET status='halted',legacy_verified=false WHERE EXISTS (
        SELECT 1 FROM order_commands c WHERE c.instrument=s.instrument AND c.result->>'status'='unverified_snapshot'
      ) OR EXISTS (SELECT 1 FROM orders o WHERE o.instrument=s.instrument AND NOT EXISTS (
        SELECT 1 FROM order_commands c WHERE c.order_id=o.id AND c.type='submit'
      ))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Статус halted і unverified_snapshot зберігаються при відкаті.
    await runner.query('ALTER TABLE instrument_state DROP COLUMN legacy_verified');
  }
}
