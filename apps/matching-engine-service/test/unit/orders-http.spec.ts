import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { OrdersController } from '../../src/orders/orders.controller';
import { OrdersService } from '../../src/orders/orders.service';

let app: INestApplication;
let base: string;
const submitOrder = jest.fn();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [{ provide: OrdersService, useValue: { submitOrder } }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (context: { switchToHttp(): { getRequest(): { user?: unknown } } }) => {
        context.switchToHttp().getRequest().user = { userId: 'X', email: 'x@example.test' };
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(() => app.close());
beforeEach(() => submitOrder.mockReset().mockResolvedValue([]));

function post(body: string) {
  return fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

const json = (price: string, quantity: string) =>
  `{"instrument":"ABC","side":"buy","price":${price},"quantity":${quantity}}`;

describe('JSON number lexemes', () => {
  it.each([
    ['1000000.00000000001', '1'],
    ['999999.12345678001', '1'],
    ['100.001', '1'],
    ['100', '1.000000001'],
    ['100', '1000000.000000000001'],
    ['1E2', '1.00000000000000001e0'],
  ])('rejects a lossy number that JavaScript would round into range (price %s, quantity %s)', async (price, quantity) => {
    const response = await post(json(price, quantity));
    expect(response.status).toBe(400);
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['100.25', '0.00000001', '100.25', '0.00000001'],
    ['1e2', '1e-8', '100', '0.00000001'],
    ['1000000.00', '1000000', '1000000.00', '1000000'],
    ['0.01', '1.50', '0.01', '1.50'],
  ])('keeps the exact decimal value of price %s and quantity %s', async (price, quantity, exactPrice, exactQuantity) => {
    const response = await post(json(price, quantity));
    expect(response.status).toBe(201);
    expect(submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ price: exactPrice, quantity: exactQuantity }),
      'X',
    );
  });

  it('reads only top-level members and ignores numbers and keys inside strings', async () => {
    const body = '{"instrument":"1000000.00000000001","note":{"price":1000000.00000000001},'
      + '"side":"buy","price":100.5,"quantity":2}';
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(submitOrder).toHaveBeenCalledWith(expect.objectContaining({ price: '100.5', quantity: '2' }), 'X');
  });
});

describe('decimal strings', () => {
  it('accepts exact decimal strings and passes them to the service', async () => {
    const response = await post(json('"100.25"', '"0.00000001"'));
    expect(response.status).toBe(201);
    expect(submitOrder).toHaveBeenCalledWith(expect.objectContaining({ price: '100.25', quantity: '0.00000001' }), 'X');
  });

  it.each([['null'], ['true'], ['{}']])('rejects %s instead of a price', async (price) => {
    const response = await post(json(price, '1'));
    expect(response.status).toBe(400);
    expect(submitOrder).not.toHaveBeenCalled();
  });
});
