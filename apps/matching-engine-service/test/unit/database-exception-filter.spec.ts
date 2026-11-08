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

it('leaves unrelated errors to the default handler', () => {
  const inherited = jest
    .spyOn(BaseExceptionFilter.prototype, 'catch')
    .mockImplementation(() => undefined);
  const { host, status } = setup();

  new DatabaseExceptionFilter().catch(new Error('Something else broke'), host);

  expect(status).not.toHaveBeenCalled();
  expect(inherited).toHaveBeenCalled();
});
