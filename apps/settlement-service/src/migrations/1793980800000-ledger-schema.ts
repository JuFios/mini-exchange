import { MigrationInterface, QueryRunner } from 'typeorm';
import { ASSET_SCALES } from '../ledger/amount';

export class LedgerSchema1793980800000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      CREATE TABLE assets (
        code text PRIMARY KEY,
        scale smallint NOT NULL CHECK (scale BETWEEN 1 AND 10)
      );
      CREATE TABLE accounts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id uuid,
        asset text NOT NULL REFERENCES assets(code),
        kind text NOT NULL CHECK (kind IN ('available', 'reserved', 'genesis')),
        balance numeric(57,0) NOT NULL DEFAULT 0,
        version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
        UNIQUE NULLS NOT DISTINCT (user_id, asset, kind),
        CHECK ((kind = 'genesis') = (user_id IS NULL)),
        CHECK (kind = 'genesis' OR balance >= 0)
      );
      CREATE TABLE reservations (
        reservation_id uuid PRIMARY KEY,
        user_id uuid,
        asset text REFERENCES assets(code),
        amount numeric(38,0) CHECK (amount > 0),
        remaining numeric(38,0) CHECK (remaining BETWEEN 0 AND amount),
        status text NOT NULL CHECK (status IN ('active', 'closed', 'rejected', 'released_tombstone')),
        request_hash varchar(64),
        result jsonb,
        instrument text REFERENCES assets(code),
        limit_price_ticks bigint,
        CHECK (
          (status='released_tombstone' AND instrument IS NULL AND limit_price_ticks IS NULL)
          OR (status<>'released_tombstone' AND instrument IS NOT NULL AND instrument <> 'USD'
            AND (asset='USD' OR asset=instrument) AND limit_price_ticks IS NOT NULL
            AND limit_price_ticks BETWEEN 1 AND 100000000)
        ),
        CHECK (
          (status = 'released_tombstone' AND user_id IS NULL AND asset IS NULL AND
            amount IS NULL AND remaining IS NULL AND request_hash IS NULL AND result IS NULL)
          OR (status <> 'released_tombstone' AND user_id IS NOT NULL AND asset IS NOT NULL AND
            amount IS NOT NULL AND remaining IS NOT NULL AND request_hash IS NOT NULL AND
            result IS NOT NULL AND ((status = 'active') = (remaining > 0)))
        )
      );
      CREATE INDEX reservations_user_status_idx ON reservations (user_id, status);
      CREATE INDEX reservations_active_wallet_idx ON reservations (user_id, asset) WHERE status = 'active';
      CREATE TABLE journal_entries (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        operation_id text NOT NULL UNIQUE,
        type text NOT NULL CHECK (type IN ('genesis', 'reserve', 'trade', 'release')),
        trade_id uuid UNIQUE,
        reservation_id uuid REFERENCES reservations(reservation_id),
        created_at timestamptz NOT NULL DEFAULT now(),
        trace_id text
      );
      CREATE INDEX journal_entries_type_created_idx ON journal_entries (type, created_at);
      CREATE TABLE postings (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id bigint NOT NULL REFERENCES journal_entries(id),
        account_id bigint NOT NULL REFERENCES accounts(id),
        asset text NOT NULL REFERENCES assets(code),
        direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount numeric(38,0) NOT NULL CHECK (amount > 0)
      );
      CREATE INDEX postings_entry_idx ON postings (entry_id);
      CREATE INDEX postings_account_idx ON postings (account_id, id);
      CREATE TABLE settled_trades (
        trade_id uuid PRIMARY KEY,
        instrument text NOT NULL,
        payload_hash varchar(64) NOT NULL,
        executed_at timestamptz NOT NULL,
        settled_at timestamptz NOT NULL DEFAULT now(),
        stream_id text,
        entry_id bigint UNIQUE REFERENCES journal_entries(id)
      );
      CREATE INDEX settled_trades_instrument_executed_idx ON settled_trades (instrument, executed_at, trade_id);
      CREATE INDEX settled_trades_executed_idx ON settled_trades (executed_at, trade_id);
      CREATE TABLE settlement_failures (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        stream text NOT NULL,
        message_id text NOT NULL,
        trade_id uuid,
        reason text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (stream, message_id)
      );
      CREATE INDEX settlement_failures_trade_idx ON settlement_failures (trade_id);
      CREATE INDEX settlement_failures_created_idx ON settlement_failures (created_at);
    `);
    for (const [asset, scale] of Object.entries(ASSET_SCALES)) {
      await db.query('INSERT INTO assets (code, scale) VALUES ($1, $2)', [asset, scale]);
    }
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'DROP TABLE settlement_failures, settled_trades, postings, journal_entries, reservations, accounts, assets',
    );
  }
}
