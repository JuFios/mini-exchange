import { MigrationInterface, QueryRunner } from 'typeorm';

export class LegacyOrdersAndTradeLookups1793980800003 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `LOCK TABLE instruments,instrument_state,orders,order_commands IN ACCESS EXCLUSIVE MODE`,
    );
    // Старий matcher не зберігав історію trades. Імпортуємо знімок, а не вигадуємо виконання.
    await runner.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM orders o WHERE priority_seq IS NULL AND (
          status='pending' OR EXISTS (SELECT 1 FROM instruments i JOIN instrument_state s ON s.instrument=i.symbol WHERE i.symbol=o.instrument AND (i.next_seq<>0 OR s.last_applied_seq<>0)) OR EXISTS (SELECT 1 FROM order_commands c WHERE c.instrument=o.instrument)
          OR EXISTS (SELECT 1 FROM orders n WHERE n.instrument=o.instrument AND n.priority_seq IS NOT NULL)
        )
      ) THEN RAISE EXCEPTION 'Cannot import mixed legacy and sequenced order history'; END IF;
    END $$;
    CREATE TEMP TABLE legacy_order_priorities ON COMMIT DROP AS
      SELECT id,instrument,row_number() OVER (PARTITION BY instrument ORDER BY created_at,id) AS seq
      FROM orders WHERE priority_seq IS NULL;
    UPDATE orders o SET priority_seq=l.seq,
      filled_quantity=CASE WHEN status IN ('open','partially_filled','filled') THEN quantity-remaining_quantity ELSE filled_quantity END
      FROM legacy_order_priorities l WHERE o.id=l.id;
    INSERT INTO order_commands(instrument,seq,type,order_id,user_id,payload,accepted_at,applied_at,result)
      SELECT o.instrument,l.seq,'submit',o.id,o.owner_id,
        jsonb_build_object('side',o.side,'price',o.price::text,'quantity',o.quantity::text,
          'status',o.status,'remainingQuantity',o.remaining_quantity::text,'legacySnapshot',true),
        o.created_at,now(),jsonb_build_object('status','imported_snapshot','tradeIds',jsonb_build_array())
      FROM orders o JOIN legacy_order_priorities l ON o.id=l.id;
    UPDATE instruments i SET next_seq=GREATEST(i.next_seq,l.seq)
      FROM (SELECT instrument,max(seq) AS seq FROM legacy_order_priorities GROUP BY instrument) l WHERE i.symbol=l.instrument;
    UPDATE instrument_state s SET last_applied_seq=l.seq,
      resting_count=(SELECT count(*) FROM orders WHERE instrument=s.instrument AND status IN ('open','partially_filled')),
      resting_quantity=(SELECT COALESCE(sum(remaining_quantity*100000000),0) FROM orders WHERE instrument=s.instrument AND status IN ('open','partially_filled')),
      resting_bid_count=(SELECT count(*) FROM orders WHERE instrument=s.instrument AND side='buy' AND status IN ('open','partially_filled')),
      resting_ask_count=(SELECT count(*) FROM orders WHERE instrument=s.instrument AND side='sell' AND status IN ('open','partially_filled')),
      resting_bid_lots=(SELECT COALESCE(sum(remaining_quantity*100000000),0) FROM orders WHERE instrument=s.instrument AND side='buy' AND status IN ('open','partially_filled')),
      resting_ask_lots=(SELECT COALESCE(sum(remaining_quantity*100000000),0) FROM orders WHERE instrument=s.instrument AND side='sell' AND status IN ('open','partially_filled'))
      FROM (SELECT instrument,max(seq) AS seq FROM legacy_order_priorities GROUP BY instrument) l WHERE s.instrument=l.instrument;
    CREATE INDEX trades_buyer_order_idx ON trades(buyer_order_id);
    CREATE INDEX trades_seller_order_idx ON trades(seller_order_id)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Імпортовані дані лишаються: відкат схеми не повинен втрачати заявки й пріоритет.
    await runner.query('DROP INDEX trades_buyer_order_idx; DROP INDEX trades_seller_order_idx');
  }
}
