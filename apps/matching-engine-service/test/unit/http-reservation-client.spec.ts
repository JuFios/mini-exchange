import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpReservationClient } from '../../src/intake/http-reservation.client';

const request = {
  reservationId: '7c9f0a52-4a8b-4a52-9f43-3b0a3a7f1c11',
  userId: 'd3c1f0a2-6f3e-4c55-8a3b-2e1f0c9d8b7a',
  instrument: 'ABC',
  limitPrice: '100.00',
  asset: 'USD',
  amount: '10000000000',
};

const client = () =>
  new HttpReservationClient(
    new ConfigService({
      SETTLEMENT_URL: 'http://settlement.test',
      INTERNAL_API_TOKEN: 'internal-token-for-tests-only-0000001',
      RESERVATION_TIMEOUT_MS: 1000,
    }),
  );

const reply = (status: number, body: object) => async () => Response.json(body, { status });

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('Expected the reservation to fail');
}

let fetch: jest.SpyInstance;
beforeEach(() => {
  fetch = jest.spyOn(globalThis, 'fetch');
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('accepts and rejects a reservation on the first answer', async () => {
  fetch.mockImplementationOnce(reply(201, { status: 'accepted' }));
  await expect(client().reserve(request)).resolves.toBe('accepted');
  fetch.mockImplementationOnce(reply(422, { code: 'INSUFFICIENT_FUNDS' }));
  await expect(client().reserve(request)).resolves.toBe('rejected');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  [401, {}],
  [400, { message: 'Некоректні параметри резерву' }],
  [409, { code: 'RESERVATION_CONFLICT' }],
])('does not repeat a %i answer and does not report it as an outage', async (status, body) => {
  fetch.mockImplementation(reply(status, body));
  expect(await statusOf(client().reserve(request))).toBe(500);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(Logger.prototype.error).toHaveBeenCalledWith(
    expect.objectContaining({ alert: 'reservation_request_refused', status }),
  );
});

it.each([
  ['a server error', reply(503, {})],
  ['a rate limit', reply(429, {})],
  [
    'a network failure',
    async () => {
      throw new TypeError('fetch failed');
    },
  ],
])('repeats %s and then reports the service as unavailable', async (_name, answer) => {
  fetch.mockImplementation(answer);
  expect(await statusOf(client().reserve(request))).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('keeps the expired-request answer for a reservation that was already released', async () => {
  fetch.mockImplementation(reply(409, { code: 'ALREADY_RELEASED' }));
  expect(await statusOf(client().reserve(request))).toBe(409);
  expect(fetch).toHaveBeenCalledTimes(1);
});
