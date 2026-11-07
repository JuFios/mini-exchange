import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../../src/config/env.validation';
import { OrdersService } from '../../src/orders/orders.service';
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
  expect(await source.query('SELECT seq,result FROM order_commands ORDER BY seq')).toMatchObject([{ seq: '1', result: { status: 'imported_snapshot' } }, { seq: '2', result: { status: 'imported_snapshot' } }]);
  expect(await source.query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([{ next_seq: '2' }]);
  expect(await source.query("SELECT resting_count,resting_quantity,resting_ask_count,resting_ask_lots FROM instrument_state WHERE instrument='ABC'"))
    .toEqual([{ resting_count: '2', resting_quantity: '300000000', resting_ask_count: '2', resting_ask_lots: '300000000' }]);
  const settings = { ...parseEnv(readFileSync('.env.example', 'utf8')), ...database.env,
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1', REDIS_PORT: process.env.REDIS_PORT ?? '6379' };
  const original = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    const { AppModule } = await import('../../src/app.module');
    const config = validateEnv(settings);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService).useValue({ getOrThrow: (key: keyof typeof config) => config[key] }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.init();
      const result = await app.get(OrdersService).submitOrder({ instrument: 'ABC', side: 'sell', price: 101, quantity: 1 }, owner);
      expect(result.status).toBe(201);
      expect(result.body.order.prioritySeq).toBe('3');
    } finally { await app.close(); }
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

});

it('indexes both sides of an order trade lookup', async () => {
  const indexes = await source.query("SELECT indexdef FROM pg_indexes WHERE tablename='trades'");
  for (const column of ['buyer_order_id', 'seller_order_id']) {
    expect(indexes.some(({ indexdef }: { indexdef: string }) => indexdef.includes(`(${column})`))).toBe(true);
  }
  await source.query(`INSERT INTO trades(trade_id,instrument,seq,fill_index,price,quantity,quote_amount,buyer_order_id,seller_order_id,buyer_user_id,seller_user_id,taker_side,executed_at)
    SELECT gen_random_uuid(),'ABC',i,0,100,1,1000000000000,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'buy',now()
    FROM generate_series(1,20000) i`);
  await source.query('ANALYZE trades');
  const plan = JSON.stringify(await source.query(`EXPLAIN (FORMAT JSON) SELECT * FROM trades
    WHERE buyer_order_id=$1 OR seller_order_id=$1 ORDER BY seq,fill_index`, [randomUUID()]));
  expect(plan).toContain('trades_buyer_order_idx');
  expect(plan).toContain('trades_seller_order_idx');
  expect(plan).not.toContain('Seq Scan');
});
