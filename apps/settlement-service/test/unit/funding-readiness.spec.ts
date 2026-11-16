import { ReservationsController } from '../../src/reservations/reservations.controller';

it('fails before reserving when the committed source or consumer permission is unavailable', async () => {
  for (const unavailable of ['outbox', 'consumer']) {
    const reserve = jest.fn();
    const page = jest.fn(async () => {
      if (unavailable === 'outbox') throw new Error('HTTP 401');
      return [];
    });
    const controller = new ReservationsController(
      { reserve } as never,
      { page } as never,
      {
        get: () => ({ redisReady: async () => false }),
      } as never,
    );
    await expect(controller.reserve({} as never)).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled();
    await expect(controller.reserve({} as never)).rejects.toThrow();
    expect(page).toHaveBeenCalledTimes(2);
  }
});

it('shares successful funding probes and leaves compensation independent of that gate', async () => {
  const page = jest.fn(async () => []);
  const redisReady = jest.fn(async () => true);
  const reserve = jest.fn(async () => ({ status: 'reserved' }));
  const release = jest.fn(async () => ({ status: 'released' }));
  const assertCompensation = jest.fn(async () => undefined);
  const controller = new ReservationsController(
    { reserve, release } as never,
    { page, assertCompensation } as never,
    { get: () => ({ redisReady }) } as never,
  );
  await Promise.all(Array.from({ length: 10 }, () => controller.reserve({} as never)));
  await controller.ready();
  expect(page).toHaveBeenCalledTimes(1);
  expect(redisReady).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(10);
  await controller.release('order');
  expect(assertCompensation).toHaveBeenCalledWith('order');
  expect(release).toHaveBeenCalledWith('order');
});
