import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { Instrument } from '../../src/orders/entities/instrument.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { DataSource } from 'typeorm';
import { IntakeService } from '../../src/intake/intake.service';
import { NoopReservationClient } from '../../src/intake/reservation.client';
import { PgNotifications } from '../../src/engine/pg-notifications';
import { SubmitOrderDto } from '../../src/orders/dto/submit-order.dto';
import { OrdersController } from '../../src/orders/orders.controller';
import { OrdersService } from '../../src/orders/orders.service';

let app: INestApplication;
let base: string;
const rows: Order[] = [];
const repository = {
  findOneBy: async ({ id }: { id: string }) => rows.find((order) => order.id === id),
};
const manager = {
  getRepository: () => repository,
  query: async (sql: string) => (sql.includes('applied_at') ? [{ applied_at: new Date() }] : []),
};
const source = {
  ...manager,
  transaction: async (_isolation: string, read: (db: typeof manager) => Promise<unknown>) =>
    read(manager),
};
const catalog = { require: (symbol: string) => symbol };
const intake = {
  submit: async (dto: SubmitOrderDto, ownerId: string) => {
    const normalized = new IntakeService(
      source as unknown as DataSource,
      new ConfigService({ REDIS_HOST: '127.0.0.1', REDIS_PORT: 6379 }),
      catalog as InstrumentCatalog,
      new NoopReservationClient(),
    ).normalize(dto);
    const order = {
      ...normalized,
      ownerId,
      id: 'order',
      status: 'open',
      remainingQuantity: normalized.quantity,
    } as Order;
    rows.push(order);
    return { orderId: order.id, seq: '1', replay: false };
  },
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [
      OrdersService,
      { provide: DataSource, useValue: source },
      { provide: IntakeService, useValue: intake },
      {
        provide: PgNotifications,
        useValue: { wait: () => ({ ready: Promise.resolve(), cancel: () => undefined }) },
      },
      InstrumentCatalog,
      {
        provide: ConfigService,
        useValue: new ConfigService({ INSTRUMENTS: ['ABC', 'XYZ'], ORDER_SYNC_WAIT_MS: 100 }),
      },
      {
        provide: getRepositoryToken(Instrument),
        useValue: {
          find: async () => [{ symbol: 'ABC' }, { symbol: 'XYZ' }],
        },
      },
      { provide: getRepositoryToken(Order), useValue: repository },
    ],
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
beforeEach(() => {
  rows.length = 0;
});

function post(body: string) {
  return fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const json = (price: string, quantity: string) =>
  `{"instrument":"ABC","side":"buy","price":${price},"quantity":${quantity}}`;

describe('JSON number lexemes', () => {
  it.each([
    ['1000000.00000000001', '1'],
    ['100', '999999.12345678001'],
    ['100.001', '1'],
    ['100', '1.000000001'],
    ['100', '1000000.000000000001'],
    ['1E2', '1.00000000000000001e0'],
  ])(
    'rejects a lossy number that JavaScript would round into range (price %s, quantity %s)',
    async (price, quantity) => {
      const response = await post(json(price, quantity));
      expect(response.status).toBe(400);
      expect(rows).toEqual([]);
    },
  );

  it.each([
    ['100.25', '0.00000001', '100.25', '0.00000001'],
    ['1e2', '1e-8', '100.00', '0.00000001'],
    ['1000000.00', '1000000', '1000000.00', '1000000.00000000'],
    ['0.01', '1.50', '0.01', '1.50000000'],
  ])(
    'stores price %s and quantity %s exactly',
    async (price, quantity, exactPrice, exactQuantity) => {
      const response = await post(json(price, quantity));
      expect(response.status).toBe(201);
      expect(rows).toMatchObject([{ price: exactPrice, quantity: exactQuantity }]);
    },
  );

  it('rejects a body that is not valid JSON', async () => {
    const response = await post('{"instrument":"ABC","price":1.5,');
    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });

  it('reads only top-level members and ignores numbers and keys inside strings', async () => {
    const body =
      '{"instrument":"ABC","note":{"label":"1000000.00000000001","price":1000000.00000000001},' +
      '"side":"buy","price":100.5,"quantity":2}';
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(rows).toMatchObject([{ instrument: 'ABC', price: '100.50', quantity: '2.00000000' }]);
  });
});

describe('decimal strings', () => {
  it('accepts exact decimal strings and passes them to the service', async () => {
    const response = await post(json('"100.25"', '"0.00000001"'));
    expect(response.status).toBe(201);
    expect(rows).toMatchObject([{ price: '100.25', quantity: '0.00000001' }]);
  });

  it.each([['null'], ['true'], ['{}']])('rejects %s instead of a price', async (price) => {
    const response = await post(json(price, '1'));
    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });
});
