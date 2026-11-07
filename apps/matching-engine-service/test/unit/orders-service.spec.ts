import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { IntakeService } from '../../src/intake/intake.service';
import { NoopReservationClient } from '../../src/intake/reservation.client';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';

const sell = { instrument: 'ABC', side: 'sell' as const, price: 100, quantity: 1 };
const service = new IntakeService(
  {} as DataSource,
  new ConfigService({ REDIS_HOST: '127.0.0.1', REDIS_PORT: 6379 }),
  {
    require: (symbol: string) => {
      if (symbol !== 'ABC') throw Object.assign(new Error(), { status: 400 });
    },
  } as InstrumentCatalog,
  new NoopReservationClient(),
);

it.each([
  { price: 1_000_000.01 },
  { price: 100.005 },
  { price: 0.001 },
  { quantity: 0.123456789 },
  { quantity: 1e-9 },
  { quantity: 1_000_000.00000001 },
])('rejects invalid amounts before accepting a request (%j)', (amount) => {
  expect(() => service.normalize({ ...sell, ...amount })).toThrow(BadRequestException);
});

it('accepts the minimum lot sent by a client as a JSON number', () => {
  expect(service.normalize({ ...sell, price: 0.01, quantity: 1e-8 })).toMatchObject({
    price: '0.01',
    quantity: '0.00000001',
  });
});

it('enforces the instrument allowlist when called without a controller', () => {
  expect(() => service.normalize({ ...sell, instrument: 'UNKNOWN' })).toThrow();
});
