import { OrdersService } from '../../src/orders/orders.service';

afterEach(() => jest.useRealTimers());

const never = () => new Promise<never>(() => undefined);
const dto = { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 } as never;

function setup(submit: jest.Mock) {
  return new OrdersService(
    {} as never,
    { submit } as never,
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
