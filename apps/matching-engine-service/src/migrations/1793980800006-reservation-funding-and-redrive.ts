import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReservationFundingAndRedrive1793980800006 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      -- true лише для заявок, прийнятих із реальним резервом; решта історії не потрапляє в ledger.
      ALTER TABLE order_requests ADD COLUMN reserved boolean NOT NULL DEFAULT false;
      -- Redrive шукає події розрахунку за tradeId, а закриття заявок за orderId.
      CREATE INDEX outbox_trade_executed_idx ON outbox ((payload->>'tradeId'))
        WHERE type = 'trade.executed';
      CREATE INDEX outbox_order_closed_idx ON outbox ((payload->>'orderId'))
        WHERE type = 'order.closed';
    `);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query(`
      DROP INDEX outbox_order_closed_idx;
      DROP INDEX outbox_trade_executed_idx;
      ALTER TABLE order_requests DROP COLUMN reserved;
    `);
  }
}
