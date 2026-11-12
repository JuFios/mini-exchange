import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { OrdersService } from '../../src/orders/orders.service';

afterEach(() => jest.useRealTimers());

const never = () => new Promise<never>(() => undefined);
const dto = { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 } as never;

function setup(submit: jest.Mock, source: object = {}, intake: object = {}) {
  return new OrdersService(
    source as never,
    { submit, ...intake } as never,
    { wait: () => ({ ready: Promise.resolve(), cancel: () => undefined }) } as never,
    { getOrThrow: () => 1 } as never,
    {} as never,
  );
}

it('leaves pool connections for the worker while orders flood in', async () => {
  jest.useFakeTimers();
  const submit = jest.fn(never);
  const orders = setup(submit);

  for (let index = 0; index < 8; index++) void orders.submitOrder(dto, 'u').catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);

  expect(submit).toHaveBeenCalledTimes(5);
});

it('answers a retriable busy error when the queue wait runs out', async () => {
  jest.useFakeTimers();
  const orders = setup(jest.fn(never));
  for (let index = 0; index < 5; index++) void orders.submitOrder(dto, 'u').catch(() => undefined);

  const waiting = orders.submitOrder(dto, 'u');
  const failure = expect(waiting).rejects.toMatchObject({
    status: 503,
    response: { code: 'ORDERS_BUSY' },
  });
  await jest.advanceTimersByTimeAsync(5000);
  await failure;
});

const accepted = { orderId: 'order-1', seq: '7', replay: false };
const busy = () => new ServiceUnavailableException({ code: 'ORDERS_BUSY' });

it.each([
  ['the status read', { query: async () => Promise.reject(busy()) }],
  [
    'the result read',
    {
      query: async () => [{ applied_at: new Date(0) }],
      transaction: async () => Promise.reject(new Error('Connection terminated')),
    },
  ],
])('answers pending when %s fails after the order was accepted', async (_step, source) => {
  const orders = setup(
    jest.fn(async () => accepted),
    source,
  );

  await expect(orders.submitOrder(dto, 'u')).resolves.toMatchObject({
    status: 202,
    body: { order: { id: 'order-1', status: 'pending' }, trades: [] },
  });
});

it('keeps client errors raised after the order was accepted', async () => {
  const source = {
    query: async () => [{ applied_at: new Date(0) }],
    transaction: async () => Promise.reject(new NotFoundException('Заявку не знайдено')),
  };
  const orders = setup(
    jest.fn(async () => accepted),
    source,
  );

  await expect(orders.submitOrder(dto, 'u')).rejects.toBeInstanceOf(NotFoundException);
});

it('answers pending when a read fails after the cancel was accepted', async () => {
  const target = { id: 'order-1', instrument: 'ABC', status: 'open' };
  const source = {
    getRepository: () => ({ findOneBy: async () => target }),
    manager: {},
    query: async () => Promise.reject(busy()),
  };
  const orders = setup(jest.fn(), source, {
    assertActive: async () => undefined,
    cancel: async () => accepted,
  });

  await expect(orders.cancelOrder('order-1', 'u')).resolves.toEqual({
    status: 202,
    body: { orderId: 'order-1', cancelSeq: '7' },
  });
});

it('cancels an order while every submission waits for settlement', async () => {
  jest.useFakeTimers();
  const target = { id: 'order-1', instrument: 'ABC', status: 'open' };
  const source = {
    getRepository: () => ({ findOneBy: async () => target }),
    manager: {},
    query: async () => [{ applied_at: new Date(0), result: { status: 'cancelled' } }],
  };
  // Прийом завис на HTTP до settlement: кроків із БД він у цей час не виконує.
  const orders = setup(jest.fn(never), source, {
    assertActive: async () => undefined,
    cancel: async () => accepted,
  });
  for (let index = 0; index < 8; index++) void orders.submitOrder(dto, 'u').catch(() => undefined);

  await expect(orders.cancelOrder('order-1', 'u')).resolves.toEqual({
    status: 200,
    body: { order: target },
  });
});

it('limits the database steps of a submission together with cancels and reads', async () => {
  jest.useFakeTimers();
  let steps = 0;
  const submit = jest.fn(
    async (_dto, _owner, _key, _trace, pg: (work: () => Promise<void>) => Promise<void>) => {
      await pg(async () => {
        steps++;
        await never();
      });
    },
  );
  const orders = setup(submit as never, {
    getRepository: () => ({ findOneBy: never }),
  });
  for (let index = 0; index < 3; index++) void orders.cancelOrder('order-1', 'u').catch(() => 0);
  for (let index = 0; index < 5; index++) void orders.submitOrder(dto, 'u').catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);

  // Три слоти з п'яти зайняли скасування, тож до БД дійшли лише два прийоми.
  expect(submit).toHaveBeenCalledTimes(5);
  expect(steps).toBe(2);
});
