import { IntakeService } from '../../src/intake/intake.service';
import { engineApp } from './engine-app';
import { waitFor } from '../helpers/wait-for';

const { register, request, submit, restart, database, app } = engineApp();

it('halts after the final issued command is lost without requiring a later submission', async () => {
  const owner = await register();
  await restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 10 });
  const { order } = await (await submit(owner)).json();
  await database().query('DELETE FROM order_commands WHERE seq=1');
  await restart({ SEQ_GAP_ALERT_MS: 30, COMMAND_POLL_INTERVAL_MS: 10 });
  await waitFor(async () => (await database().query("SELECT status FROM instrument_state WHERE instrument='ABC'"))[0].status === 'halted', 1000);
  expect((await submit(owner)).status).toBe(503);
  expect((await request(`/orders/${order.id}`, 'DELETE', owner)).status).toBe(503);
  expect(await database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([{ next_seq: '1' }]);
});

it('replays an accepted request without Redis and still rejects new intake or a mismatched hash', async () => {
  const owner = await register();
  const body = { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 };
  const headers = { 'Idempotency-Key': 'accepted-before-outage' };
  const initial = await request('/orders', 'POST', owner, body, headers);
  expect(initial.status).toBe(201);
  const accepted = await initial.json();
  const intake = app().get(IntakeService) as unknown as { redis: { ping: () => Promise<string> } };
  const failure = jest.spyOn(intake.redis, 'ping').mockRejectedValue(new Error('Redis offline'));
  try {
    const repeated = await request('/orders', 'POST', owner, body, headers);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(accepted);
    expect(failure).not.toHaveBeenCalled();
    expect((await request('/orders', 'POST', owner, { ...body, quantity: 2 }, headers)).status).toBe(409);
    expect((await submit(owner)).status).toBe(503);
    expect(await database().query('SELECT count(*)::int AS n FROM order_commands')).toEqual([{ n: 1 }]);
    expect(await database().query('SELECT count(*)::int AS n FROM order_requests')).toEqual([{ n: 1 }]);
  } finally { failure.mockRestore(); }
});
