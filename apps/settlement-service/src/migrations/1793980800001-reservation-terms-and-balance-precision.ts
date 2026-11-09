import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReservationTermsAndBalancePrecision1793980800001 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    // Сумарний баланс має вміщувати до bigint-кількості проводок із 38 цифрами кожна.
    await db.query(`
      ALTER TABLE reservations
        ADD COLUMN instrument text REFERENCES assets(code),
        ADD COLUMN limit_price_ticks bigint,
        ADD CONSTRAINT reservations_terms_check CHECK (
          (instrument IS NULL AND limit_price_ticks IS NULL)
          OR (
            instrument IS NOT NULL AND limit_price_ticks IS NOT NULL
            AND instrument <> 'USD' AND (asset='USD' OR asset=instrument)
            AND status <> 'released_tombstone'
            AND limit_price_ticks BETWEEN 1 AND 100000000
          )
        );
      ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(57,0);
    `);
  }

  async down(db: QueryRunner): Promise<void> {
    // Старий клієнт повторює reserve за хешем канонічних userId, asset і amount.
    await db.query(`
      LOCK TABLE reservations IN ACCESS EXCLUSIVE MODE;
      UPDATE reservations
      SET request_hash=encode(sha256(convert_to(format(
        '{"userId":%s,"asset":%s,"amount":%s}',
        to_json(user_id::text), to_json(asset), to_json(amount::text)
      ), 'UTF8')), 'hex')
      WHERE instrument IS NOT NULL;

      ALTER TABLE reservations
        DROP CONSTRAINT reservations_terms_check,
        DROP COLUMN limit_price_ticks,
        DROP COLUMN instrument;
      ALTER TABLE accounts ALTER COLUMN balance TYPE numeric(38,0);
    `);
  }
}
