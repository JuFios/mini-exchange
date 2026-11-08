import { ConfigService } from '@nestjs/config';
import { PgNotifications } from '../../src/engine/pg-notifications';

afterEach(() => jest.useRealTimers());

it('answers a resume request with unavailable when the notification connection hangs', async () => {
  jest.useFakeTimers();
  const destroyed = jest.fn();
  const hung = {
    query: () => new Promise<never>(() => undefined),
    connection: { stream: { destroy: destroyed } },
  };
  const notifications = new PgNotifications({} as ConfigService);
  Object.assign(notifications, { client: hung, ready: true });
  let outcome: unknown = 'pending';
  void notifications.requestResume('ABC').then((value) => {
    outcome = value;
  });
  await jest.advanceTimersByTimeAsync(3500);
  // Запит не повинен чекати на мертве з’єднання довше за ack-дедлайн.
  expect(outcome).toBeUndefined();
  expect(destroyed).toHaveBeenCalled();
});

it('keeps parallel resume requests inside one deadline and skips expired publications', async () => {
  jest.useFakeTimers();
  const published: string[] = [];
  const slow = {
    // Кожна публікація триває 1,2 с, а черга на одному з’єднанні виконується послідовно.
    query: (_sql: string, [, payload]: [string, string]) => {
      published.push(payload);
      return new Promise<void>((resolve) => setTimeout(resolve, 1200));
    },
    connection: { stream: { destroy: jest.fn() } },
  };
  const notifications = new PgNotifications({} as ConfigService);
  Object.assign(notifications, { client: slow, ready: true });
  const started = Date.now();
  const answeredAt: number[] = [];
  for (let index = 0; index < 5; index++)
    void notifications.requestResume('ABC').then(() => {
      answeredAt.push(Date.now() - started);
    });
  await jest.advanceTimersByTimeAsync(10000);

  expect(answeredAt).toHaveLength(5);
  // Дедлайн ack — 3 с від виклику, разом із очікуванням у черзі.
  expect(Math.max(...answeredAt)).toBeLessThanOrEqual(3000);
  // Публікації, що стартували б після дедлайну, власнику не надсилаються.
  expect(published).toHaveLength(3);
});
