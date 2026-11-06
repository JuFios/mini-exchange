import type { Repository } from 'typeorm';
import type { Order } from '../../src/orders/entities/order.entity';
import { OrderBookService } from '../../src/orders/order-book.service';
import { OrdersService } from '../../src/orders/orders.service';

function setup() {
  const rows: Order[] = [];
  const repository = {
    create: (order: Order) => order,
    save: async (order: Order) => { rows.push(order); },
    find: async ({ where }: { where: { ownerId: string } }) =>
      rows.filter(({ ownerId }) => ownerId === where.ownerId),
  };
  const book = new OrderBookService();
  const service = new OrdersService(repository as unknown as Repository<Order>, book);
  return { book, service, rows };
}

const sell = { instrument: 'ABC', side: 'sell' as const, price: 100, quantity: 1 };

it('persists an STP cancellation and keeps fills made before the self-cross', async () => {
  const { service } = setup();
  await service.submitOrder(sell, 'X');
  await service.submitOrder({ ...sell, price: 99 }, 'Y');

  const trades = await service.submitOrder({ ...sell, side: 'buy', quantity: 2 }, 'X');
  const [ownAsk, buy] = await service.listOwn('X');

  expect(trades).toMatchObject([{ price: '99.00', quantity: '1.00000000', buyOrderId: buy.id }]);
  // Виконаний обсяг відновлюється як quantity - remainingQuantity.
  expect(buy).toMatchObject({ status: 'cancelled', quantity: '2.00000000', remainingQuantity: '1.00000000' });
  expect(service.getDepth('ABC')).toEqual({ bids: [], asks: [ownAsk] });
});

it('keeps the whole quantity as the cancelled remainder when nothing was filled before the self-cross', async () => {
  const { service } = setup();
  await service.submitOrder(sell, 'X');

  const trades = await service.submitOrder({ ...sell, side: 'buy', quantity: 2 }, 'X');
  const [, buy] = await service.listOwn('X');

  expect(trades).toEqual([]);
  expect(buy).toMatchObject({ status: 'cancelled', quantity: '2.00000000', remainingQuantity: '2.00000000' });
});

it.each([
  { price: 1_000_000.01 }, { price: 100.005 }, { price: 0.001 },
  { quantity: 0.123456789 }, { quantity: 1e-9 }, { quantity: 1_000_000.00000001 },
])('rejects invalid amounts before reading or writing the book (%j)', async (amount) => {
  const { service, book, rows } = setup();
  const snapshot = jest.spyOn(book, 'snapshot');
  await expect(service.submitOrder({ ...sell, ...amount }, 'X')).rejects.toMatchObject({ status: 400 });
  expect(snapshot).not.toHaveBeenCalled();
  expect(rows).toEqual([]);
});

it('accepts the minimum lot sent by a client as a JSON number', async () => {
  const { service, rows } = setup();
  await expect(service.submitOrder({ ...sell, price: 0.01, quantity: 1e-8 }, 'X')).resolves.toEqual([]);
  expect(rows).toMatchObject([{ price: '0.01', quantity: '0.00000001', status: 'open' }]);
});
