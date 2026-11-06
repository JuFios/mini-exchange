import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793980800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar NOT NULL CONSTRAINT users_email_key UNIQUE,
        password_hash varchar NOT NULL,
        admin_seeded boolean NOT NULL DEFAULT false,
        refresh_session_id uuid,
        refresh_token_hash varchar,
        refresh_prev_hash varchar,
        refresh_rotated_at timestamptz
      );
      CREATE INDEX users_email_lower_idx ON users (LOWER(email COLLATE "C"));

      CREATE TABLE instruments (
        symbol varchar PRIMARY KEY,
        base_asset varchar NOT NULL,
        quote_asset varchar NOT NULL,
        tick_size numeric(18,2) NOT NULL CHECK (tick_size = 0.01),
        lot_size numeric(18,8) NOT NULL CHECK (lot_size = 0.00000001),
        -- Ці межі перевіряє парсер у src/matching/decimal.ts, тож таблиця не може їх змінити.
        min_qty numeric(18,8) NOT NULL CHECK (min_qty = 0.00000001),
        max_qty numeric(18,8) NOT NULL CHECK (max_qty = 1000000),
        max_price numeric(18,2) NOT NULL CHECK (max_price = 1000000),
        next_seq bigint NOT NULL DEFAULT 0 CHECK (next_seq >= 0)
      );

      CREATE TABLE instrument_state (
        instrument varchar PRIMARY KEY REFERENCES instruments(symbol),
        status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'halted')),
        owner_epoch bigint NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
        owner_instance varchar,
        owner_since timestamptz,
        recovered_at timestamptz,
        last_applied_seq bigint NOT NULL DEFAULT 0 CHECK (last_applied_seq >= 0),
        resting_count bigint NOT NULL DEFAULT 0 CHECK (resting_count >= 0),
        resting_quantity numeric(38,0) NOT NULL DEFAULT 0 CHECK (resting_quantity >= 0)
      );

      CREATE TABLE order_requests (
        user_id uuid NOT NULL,
        idempotency_key varchar(64) NOT NULL,
        request_hash varchar(64) NOT NULL,
        order_id uuid NOT NULL UNIQUE,
        status varchar NOT NULL CHECK (status IN ('reserving', 'accepted', 'rejected', 'releasing', 'expired')),
        response jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        release_attempts integer NOT NULL DEFAULT 0 CHECK (release_attempts >= 0),
        PRIMARY KEY (user_id, idempotency_key)
      );
      CREATE INDEX order_requests_unreleased_idx ON order_requests (created_at)
        WHERE status IN ('reserving', 'releasing');

      CREATE TABLE order_commands (
        instrument varchar NOT NULL REFERENCES instruments(symbol),
        seq bigint NOT NULL CHECK (seq > 0),
        type varchar NOT NULL CHECK (type IN ('submit', 'cancel')),
        order_id uuid NOT NULL,
        user_id uuid NOT NULL,
        payload jsonb NOT NULL,
        traceparent varchar,
        accepted_at timestamptz NOT NULL DEFAULT now(),
        applied_at timestamptz,
        result jsonb,
        PRIMARY KEY (instrument, seq)
      );
      CREATE UNIQUE INDEX order_commands_submit_idx ON order_commands (order_id) WHERE type = 'submit';
      CREATE UNIQUE INDEX order_commands_cancel_idx ON order_commands (order_id) WHERE type = 'cancel';
      CREATE INDEX order_commands_unapplied_idx ON order_commands (instrument, seq) WHERE applied_at IS NULL;

      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL,
        instrument varchar NOT NULL REFERENCES instruments(symbol),
        side varchar NOT NULL CHECK (side IN ('buy', 'sell')),
        price numeric(18,2) NOT NULL CHECK (price > 0),
        quantity numeric(18,8) NOT NULL,
        remaining_quantity numeric(18,8) NOT NULL,
        filled_quantity numeric(18,8) NOT NULL DEFAULT 0,
        status varchar NOT NULL DEFAULT 'open'
          CHECK (status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled')),
        priority_seq bigint CHECK (priority_seq > 0),
        cancel_reason varchar,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT orders_remaining_quantity_check CHECK (remaining_quantity BETWEEN 0 AND quantity),
        CONSTRAINT orders_filled_quantity_check
          CHECK (filled_quantity >= 0 AND filled_quantity + remaining_quantity <= quantity)
      );
      CREATE INDEX orders_owner_idx ON orders (owner_id, created_at DESC, id DESC);
      CREATE INDEX orders_owner_status_idx ON orders (owner_id, status, created_at DESC, id DESC);
      CREATE INDEX orders_resting_idx ON orders (instrument, side, price, priority_seq)
        WHERE status IN ('open', 'partially_filled');

      CREATE TABLE trades (
        trade_id uuid PRIMARY KEY,
        instrument varchar NOT NULL REFERENCES instruments(symbol),
        seq bigint NOT NULL CHECK (seq > 0),
        fill_index integer NOT NULL CHECK (fill_index >= 0),
        price numeric(18,2) NOT NULL CHECK (price > 0),
        quantity numeric(18,8) NOT NULL CHECK (quantity > 0),
        quote_amount numeric(38,0) NOT NULL CHECK (quote_amount > 0),
        buyer_order_id uuid NOT NULL,
        seller_order_id uuid NOT NULL,
        buyer_user_id uuid NOT NULL,
        seller_user_id uuid NOT NULL,
        taker_side varchar NOT NULL CHECK (taker_side IN ('buy', 'sell')),
        executed_at timestamptz NOT NULL,
        trace_id varchar,
        UNIQUE (instrument, seq, fill_index)
      );
      CREATE INDEX trades_instrument_time_idx ON trades (instrument, executed_at, trade_id);
      CREATE INDEX trades_time_idx ON trades (executed_at, trade_id);
      CREATE INDEX trades_buyer_idx ON trades (buyer_user_id, executed_at);
      CREATE INDEX trades_seller_idx ON trades (seller_user_id, executed_at);

      CREATE TABLE outbox (
        id bigserial PRIMARY KEY,
        event_id uuid NOT NULL UNIQUE,
        stream varchar NOT NULL,
        type varchar NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        instrument varchar REFERENCES instruments(symbol),
        seq bigint CHECK (seq > 0),
        payload jsonb NOT NULL,
        traceparent varchar,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      );
      CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE outbox, trades, orders, order_commands, order_requests, instrument_state, instruments, users;
    `);
  }
}
