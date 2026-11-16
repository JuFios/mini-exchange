import { MigrationInterface, QueryRunner } from 'typeorm';

export class SettlementPosition1793980800009 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE outbox ADD COLUMN settlement_position bigint`);
    await db.query(`UPDATE outbox SET settlement_position=id`);
    await db.query(`ALTER TABLE outbox ALTER COLUMN settlement_position SET NOT NULL`);
    await db.query(`CREATE FUNCTION preserve_settlement_position() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' THEN NEW.settlement_position=NEW.id;
        ELSE NEW.settlement_position=OLD.settlement_position; END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE TRIGGER outbox_settlement_position BEFORE INSERT OR UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION preserve_settlement_position()`);
    await db.query(`CREATE UNIQUE INDEX outbox_settlement_position_idx ON outbox
      (instrument, settlement_position) WHERE type IN ('trade.executed','order.closed')`);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query('DROP TRIGGER outbox_settlement_position ON outbox');
    await db.query('DROP FUNCTION preserve_settlement_position()');
    await db.query('ALTER TABLE outbox DROP COLUMN settlement_position');
  }
}
