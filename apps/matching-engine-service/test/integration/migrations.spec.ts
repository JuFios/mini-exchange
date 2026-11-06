import { randomUUID } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { migrate } from '../../src/database/migrate';
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
    expect(await source.query('SELECT count(*)::int AS count FROM migrations')).toEqual([{ count: 2 }]);
    expect(await source.query('SELECT count(*)::int AS count FROM instruments')).toEqual([{ count: 2 }]);
  } finally {
    await second.destroy();
  }
});

it('rolls back schema and history when the migration connection is terminated', async () => {
  class Interrupted1793980800002 implements MigrationInterface {
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
  source.migrations.push(new Interrupted1793980800002());
  await expect(migrate(source, 'run')).rejects.toThrow(/terminat|released/i);
  source.migrations.pop();

  expect(await source.query(`
    SELECT to_regclass('orders') AS orders, to_regclass('migrations') AS migrations,
           to_regclass('migration_probe') AS probe
  `)).toEqual([{ orders: null, migrations: null, probe: null }]);
  await migrate(source, 'run');
  expect(await source.query('SELECT count(*)::int AS count FROM migrations')).toEqual([{ count: 2 }]);
});
