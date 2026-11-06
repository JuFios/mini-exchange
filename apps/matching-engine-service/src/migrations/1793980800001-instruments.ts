import { MigrationInterface, QueryRunner } from 'typeorm';

export class Instruments1793980800001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO instruments (symbol, base_asset, quote_asset, tick_size, lot_size, min_qty, max_qty, max_price)
      VALUES
        ('ABC', 'ABC', 'USD', 0.01, 0.00000001, 0.00000001, 1000000, 1000000),
        ('XYZ', 'XYZ', 'USD', 0.01, 0.00000001, 0.00000001, 1000000, 1000000);
      INSERT INTO instrument_state (instrument) VALUES ('ABC'), ('XYZ');
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM instrument_state WHERE instrument IN ('ABC', 'XYZ');
      DELETE FROM instruments WHERE symbol IN ('ABC', 'XYZ');
    `);
  }
}
