import { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DatabaseExceptionFilter } from '../../src/database/database-exception.filter';

function setup() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status };
}

afterEach(() => jest.restoreAllMocks());

it.each([
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'timeout exceeded when trying to connect',
])('answers 503 to the retriable pool failure "%s"', (message) => {
  const { host, status } = setup();

  new DatabaseExceptionFilter().catch(new Error(message), host);

  expect(status).toHaveBeenCalledWith(503);
});

it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', '25P03'])(
  'answers 503 to the retriable connection failure %s',
  (code) => {
    const { host, status } = setup();

    new DatabaseExceptionFilter().catch(Object.assign(new Error('down'), { code }), host);

    expect(status).toHaveBeenCalledWith(503);
  },
);

it.each([
  'Query runner already released. Cannot run queries anymore.',
  'Database connection provided by a query runner was already released, cannot continue to use its querying methods anymore.',
])('answers 503 when work continues on a lost connection: %s', (message) => {
  const { host, status } = setup();

  new DatabaseExceptionFilter().catch(new Error(message), host);

  expect(status).toHaveBeenCalledWith(503);
});

it('leaves unrelated errors to the default handler', () => {
  const inherited = jest
    .spyOn(BaseExceptionFilter.prototype, 'catch')
    .mockImplementation(() => undefined);
  const { host, status } = setup();

  new DatabaseExceptionFilter().catch(new Error('Something else broke'), host);

  expect(status).not.toHaveBeenCalled();
  expect(inherited).toHaveBeenCalled();
});
