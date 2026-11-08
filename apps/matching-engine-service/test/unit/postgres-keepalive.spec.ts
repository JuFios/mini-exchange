import { Client } from 'pg';
import { validateDatabaseEnv } from '../../src/config/env.validation';
import { engineDataSourceOptions } from '../../src/data-source';
import { PgNotifications } from '../../src/engine/pg-notifications';

jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

const keepAlive = { keepAlive: true, keepAliveInitialDelayMillis: 5000 };

it('enables keepalive on pooled connections', () => {
  const options = engineDataSourceOptions(
    validateDatabaseEnv({
      DATABASE_HOST: 'db',
      DATABASE_PORT: '5432',
      DATABASE_USER: 'user',
      DATABASE_PASSWORD: 'password',
      DATABASE_NAME: 'name',
    }),
  );

  expect(options.extra).toMatchObject(keepAlive);
});

it('enables keepalive on the notification connection', async () => {
  const notifications = new PgNotifications({
    getOrThrow: (key: string) => (key === 'DATABASE_PORT' ? 5432 : key),
  } as never);

  await notifications.onModuleInit();

  expect(Client).toHaveBeenCalledWith(expect.objectContaining(keepAlive));
  await notifications.onModuleDestroy();
});

it('reconnects when the LISTEN query never gets a reply', async () => {
  jest.useFakeTimers();
  jest.mocked(Client).mockImplementationOnce(
    () =>
      ({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(() => new Promise(() => undefined)),
        end: jest.fn().mockResolvedValue(undefined),
      }) as never,
  );
  const notifications = new PgNotifications({
    getOrThrow: (key: string) => (key === 'DATABASE_PORT' ? 5432 : key),
  } as never);

  const started = notifications.onModuleInit();
  await jest.advanceTimersByTimeAsync(2100);
  await started;

  expect(Client).toHaveBeenCalledTimes(2);
  await notifications.onModuleDestroy();
});
