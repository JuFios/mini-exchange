import { randomUUID } from 'node:crypto';
import { BookLoader } from '../../src/engine/book-loader';
import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';

const database = testDatabase();
const source = database.source();
beforeAll(async () => { await database.create(); await source.initialize(); });
afterAll(async () => { await source.destroy(); await database.destroy(); });

it('upgrades legacy resting orders with deterministic priorities and consistent sequence and counters', async () => {
  const migrations = [...source.migrations];
  source.migrations.splice(2);
  await migrate(source, 'run');
  const owner = randomUUID();
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  for (const [i, id] of ids.entries()) await source.query(`INSERT INTO orders(id,owner_id,instrument,side,price,quantity,remaining_quantity,status,created_at)
    VALUES ($1,$2,'ABC','sell',100,2,$3,$4,'2026-11-01T00:00:00Z')`, [id, owner, i ? 1 : 2, i ? 'partially_filled' : 'open']);
  source.migrations.splice(0, source.migrations.length, ...migrations);
  await migrate(source, 'run');
  const loaded = await source.transaction((db) => new BookLoader().load(db, 'ABC'));
  expect(loaded).toMatchObject({ halted: false, seq: '2', book: { asks: [{ id: ids[0], prioritySeq: 1n }, { id: ids[1], prioritySeq: 2n }] } });
  expect(await source.query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([{ next_seq: '2' }]);
  expect(await source.query("SELECT resting_count,resting_quantity,resting_ask_count,resting_ask_lots FROM instrument_state WHERE instrument='ABC'"))
    .toEqual([{ resting_count: '2', resting_quantity: '300000000', resting_ask_count: '2', resting_ask_lots: '300000000' }]);
});

it('indexes both sides of an order trade lookup', async () => {
  const indexes = await source.query("SELECT indexdef FROM pg_indexes WHERE tablename='trades'");
  for (const column of ['buyer_order_id', 'seller_order_id']) {
    expect(indexes.some(({ indexdef }: { indexdef: string }) => indexdef.includes(`(${column})`))).toBe(true);
  }
});
