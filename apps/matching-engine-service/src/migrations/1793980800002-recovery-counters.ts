import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecoveryCounters1793980800002 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE instrument_state
      ADD COLUMN resting_bid_count bigint NOT NULL DEFAULT 0 CHECK (resting_bid_count>=0),
      ADD COLUMN resting_ask_count bigint NOT NULL DEFAULT 0 CHECK (resting_ask_count>=0),
      ADD COLUMN resting_bid_lots numeric(38,0) NOT NULL DEFAULT 0 CHECK (resting_bid_lots>=0),
      ADD COLUMN resting_ask_lots numeric(38,0) NOT NULL DEFAULT 0 CHECK (resting_ask_lots>=0)`);
    // Нові лічильники відображають уже закомічені resting-заявки під час оновлення схеми.
    await runner.query(`UPDATE instrument_state s SET
      resting_bid_count=(SELECT count(*) FROM orders WHERE instrument=s.instrument AND side='buy' AND status IN ('open','partially_filled')),
      resting_ask_count=(SELECT count(*) FROM orders WHERE instrument=s.instrument AND side='sell' AND status IN ('open','partially_filled')),
      resting_bid_lots=(SELECT COALESCE(sum(remaining_quantity*100000000),0) FROM orders WHERE instrument=s.instrument AND side='buy' AND status IN ('open','partially_filled')),
      resting_ask_lots=(SELECT COALESCE(sum(remaining_quantity*100000000),0) FROM orders WHERE instrument=s.instrument AND side='sell' AND status IN ('open','partially_filled'))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE instrument_state DROP COLUMN resting_bid_count,DROP COLUMN resting_ask_count,DROP COLUMN resting_bid_lots,DROP COLUMN resting_ask_lots');
  }
}
