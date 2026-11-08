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
