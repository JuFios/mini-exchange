import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReservationMode1793980800007 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE engine_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      reservations_required boolean NOT NULL DEFAULT false
    ); INSERT INTO engine_settings DEFAULT VALUES;
    CREATE FUNCTION enforce_reservation_mode() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE required boolean;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM order_requests WHERE order_id=NEW.id AND reserved) THEN
        -- Старі репліки теж мають пройти спільний бар’єр увімкнення резервів.
        SELECT reservations_required INTO required FROM engine_settings WHERE id=true FOR SHARE;
        IF required IS DISTINCT FROM false THEN
          RAISE EXCEPTION 'An order requires a reservation' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_reservation_mode BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION enforce_reservation_mode()`);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'DROP TRIGGER orders_reservation_mode ON orders; DROP FUNCTION enforce_reservation_mode(); DROP TABLE engine_settings',
    );
  }
}
