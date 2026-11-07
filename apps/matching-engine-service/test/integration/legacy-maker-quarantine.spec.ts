import { randomUUID } from 'node:crypto';
import { BookLoader } from '../../src/engine/book-loader';
import { migrate } from '../../src/database/migrate';
import { matchOrder } from '../../src/orders/matcher';
import { Order } from '../../src/orders/entities/order.entity';
import { BookSnapshot } from '../../src/orders/order-book.types';
import { testDatabase } from '../test-database';

const database = testDatabase();
const source = database.source();
beforeAll(async () => {
  await database.create();
  await source.initialize();
});
afterAll(async () => {
  await source.destroy();
  await database.destroy();
});

it('quarantines a stale maker even when its imported journal records were lost', async () => {
  const migrations = [...source.migrations];
  source.migrations.splice(2);
  await migrate(source, 'run');
  let book: BookSnapshot = { bids: [], asks: [] };
  async function legacySubmit(side: 'buy' | 'sell') {
    const incoming: Order = {
      id: randomUUID(),
      ownerId: randomUUID(),
      instrument: 'ABC',
      side,
      price: '100.00',
      quantity: '1.00000000',
      remainingQuantity: '1.00000000',
      status: 'open',
      createdAt: new Date(),
    };
    const result = matchOrder(book, incoming);
    const settled = result.cancelledIncoming ?? result.restingOrder;
    await source.getRepository(Order).save({
      ...incoming,
      status: settled?.status ?? 'filled',
      remainingQuantity: settled?.remainingQuantity ?? '0',
    });
    book = { bids: result.updatedBids, asks: result.updatedAsks };
    return incoming.id;
  }
  const maker = await legacySubmit('sell');
  await legacySubmit('buy');
  expect(book).toEqual({ bids: [], asks: [] });
  expect(await source.getRepository(Order).findOneBy({ id: maker })).toMatchObject({
    status: 'open',
    remainingQuantity: '1.00000000',
  });
  source.migrations.splice(0, source.migrations.length, ...migrations.slice(0, 4));
  await migrate(source, 'run');
  await source.query("DELETE FROM order_commands WHERE instrument='ABC'");
  source.migrations.splice(0, source.migrations.length, ...migrations);
  await migrate(source, 'run');
  const loaded = await source.transaction((db) => new BookLoader().load(db, 'ABC'));
  expect(loaded).toMatchObject({ halted: true, book: { bids: [], asks: [] } });
  expect(await source.query("SELECT status FROM instrument_state WHERE instrument='ABC'")).toEqual([
    { status: 'halted' },
  ]);
  await source.query("UPDATE instrument_state SET status='active' WHERE instrument='ABC'");
  expect(await source.transaction((db) => new BookLoader().load(db, 'ABC'))).toMatchObject({
    halted: true,
    book: { bids: [], asks: [] },
  });
});
