import { randomUUID } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { advisoryLocks } from '../../src/database/advisory-lock';
import { migrate } from '../../src/database/migrate';
import { formatPrice, formatQuantity, parsePrice, parseQuantity } from '../../src/matching/decimal';
import { testDatabase } from '../test-database';

let database: ReturnType<typeof testDatabase>;
let source: ReturnType<typeof database.source>;

beforeEach(async () => {
  database = testDatabase();
  source = database.source();
  await database.create();
  await source.initialize();
});

afterEach(async () => {
  try {
    if (source.isInitialized) await source.destroy();
  } finally {
    await database.destroy();
  }
});

it('applies, reverts, and reapplies the schema with database constraints', async () => {
  expect(await source.query("SELECT to_regclass('orders') AS name")).toEqual([{ name: null }]);
  await migrate(source, 'run');

  const [orderId, ownerId] = [randomUUID(), randomUUID()];
  const command = `INSERT INTO order_commands (instrument, seq, type, order_id, user_id, payload)
    VALUES ('ABC', 1, 'submit', $1, $2, '{}')`;
  await source.query(command, [orderId, ownerId]);
  await expect(source.query(command, [randomUUID(), ownerId])).rejects.toMatchObject({
    code: '23505', constraint: 'order_commands_pkey',
  });
  await expect(source.query(
    `INSERT INTO orders (owner_id, instrument, side, price, quantity, remaining_quantity, created_at)
     VALUES ($1, 'ABC', 'buy', 100, 1, 2, now())`, [ownerId],
  )).rejects.toMatchObject({ code: '23514' });

  await source.query('DELETE FROM order_commands WHERE order_id = $1', [orderId]);
  for (let cycle = 0; cycle < 2; cycle++) {
    await migrate(source, 'revert');
    await migrate(source, 'revert');
    expect(await source.query('SELECT symbol FROM instruments ORDER BY symbol')).toEqual([{ symbol: 'ABC' }, { symbol: 'XYZ' }]);
    await migrate(source, 'revert');
    expect(await source.query('SELECT symbol FROM instruments')).toEqual([]);
    await migrate(source, 'revert');
    expect(await source.query("SELECT to_regclass('orders') AS name")).toEqual([{ name: null }]);
    await migrate(source, 'run');
    expect(await source.query('SELECT symbol FROM instruments ORDER BY symbol')).toEqual([
      { symbol: 'ABC' }, { symbol: 'XYZ' },
    ]);
  }
});

it('serializes concurrent migrations on an empty schema', async () => {
  const second = database.source();
  await second.initialize();
  try {
    await Promise.all([migrate(source, 'run'), migrate(second, 'run')]);
    expect(await source.query('SELECT count(*)::int AS count FROM migrations')).toEqual([{ count: 4 }]);
    expect(await source.query('SELECT count(*)::int AS count FROM instruments')).toEqual([{ count: 2 }]);
  } finally {
    await second.destroy();
  }
});

it('rolls back schema and history when the migration connection is terminated', async () => {
  class Interrupted1793980800004 implements MigrationInterface {
    async up(runner: QueryRunner): Promise<void> {
      await runner.query('CREATE TABLE migration_probe (id integer)');
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid') as { pid: number }[];
      await source.query('SELECT pg_terminate_backend($1)', [pid]);
      await runner.query('SELECT 1');
    }

    async down(runner: QueryRunner): Promise<void> {
      await runner.query('DROP TABLE migration_probe');
    }
  }
  source.migrations.push(new Interrupted1793980800004());
  await expect(migrate(source, 'run')).rejects.toThrow(/terminat|released/i);
  source.migrations.pop();

  expect(await source.query(`
    SELECT to_regclass('orders') AS orders, to_regclass('migrations') AS migrations,
           to_regclass('migration_probe') AS probe
  `)).toEqual([{ orders: null, migrations: null, probe: null }]);
  await migrate(source, 'run');
  expect(await source.query('SELECT count(*)::int AS count FROM migrations')).toEqual([{ count: 4 }]);
});

it('fails with a clear error instead of waiting forever for a migration lock held elsewhere', async () => {
  const holder = database.source();
  await holder.initialize();
  const runner = holder.createQueryRunner();
  try {
    await runner.startTransaction();
    await runner.query('SELECT pg_advisory_xact_lock($1, $2)', [...advisoryLocks.migrations.key]);

    const started = Date.now();
    await expect(migrate(source, 'run', { lockTimeoutMs: 200 })).rejects.toThrow(/Timed out after 200 ms.*migrations lock/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await source.query("SELECT to_regclass('orders') AS name")).toEqual([{ name: null }]);

    await runner.commitTransaction();
    await migrate(source, 'run', { lockTimeoutMs: 200 });
    expect(await source.query('SELECT count(*)::int AS count FROM migrations')).toEqual([{ count: 4 }]);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await holder.destroy();
  }
});

it('keeps instrument limits equal to the bounds enforced by the amount parser', async () => {
  await migrate(source, 'run');
  const [row] = await source.query(
    "SELECT tick_size, lot_size, min_qty, max_qty, max_price FROM instruments WHERE symbol = 'ABC'",
  ) as Record<string, string>[];
  expect(row).toEqual({
    tick_size: formatPrice(parsePrice('0.01')),
    lot_size: formatQuantity(parseQuantity('0.00000001')),
    min_qty: formatQuantity(parseQuantity('0.00000001')),
    max_qty: formatQuantity(parseQuantity('1000000')),
    max_price: formatPrice(parsePrice('1000000')),
  });
  expect(() => parseQuantity('1000000.00000001')).toThrow();
  expect(() => parsePrice('1000000.01')).toThrow();

  // Таблиця не може оголосити інші межі, ніж ті, що реально перевіряє парсер.
  await expect(source.query(
    `INSERT INTO instruments (symbol, base_asset, quote_asset, tick_size, lot_size, min_qty, max_qty, max_price)
     VALUES ('DEF', 'DEF', 'USD', 0.01, 0.00000001, 0.00000001, 100, 1000000)`,
  )).rejects.toMatchObject({ code: '23514' });
});
