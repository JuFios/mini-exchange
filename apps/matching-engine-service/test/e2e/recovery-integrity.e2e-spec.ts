import { engineApp } from './engine-app';
import { waitFor } from '../helpers/wait-for';
const api = engineApp();

it.each(['first', 'middle', 'tail', 'applied-prefix', 'applied-ahead', 'counter-behind'])(
  'refuses resume with a corrupt %s journal and resumes only after repair',
  async (fault) => {
    const token = await api.register();
    if (fault === 'applied-prefix' || fault === 'counter-behind')
      expect((await api.submit(token)).status).toBe(201);
    await api.restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
    const current = (
      await api.database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")
    )[0].next_seq;
    for (let i = Number(current); i < 3; i++) expect((await api.submit(token)).status).toBe(202);
    const commands = await api
      .database()
      .query("SELECT * FROM order_commands WHERE instrument='ABC' ORDER BY seq");
    const index = fault === 'middle' ? 1 : fault === 'tail' ? 2 : 0;
    const removed = commands[index];
    if (fault === 'applied-ahead')
      await api
        .database()
        .query("UPDATE order_commands SET applied_at=now() WHERE instrument='ABC' AND seq=3");
    else if (fault === 'counter-behind')
      await api.database().query("UPDATE instruments SET next_seq=0 WHERE symbol='ABC'");
    else
      await api
        .database()
        .query("DELETE FROM order_commands WHERE instrument='ABC' AND seq=$1", [removed.seq]);
    await api
      .database()
      .query("UPDATE instrument_state SET status='halted' WHERE instrument='ABC'");
    await api.restart();
    const login = await api.request('/auth/login', 'POST', undefined, {
      email: 'admin@demo.local',
      password: 'demo-admin-local-only',
    });
    const admin = (await login.json()).accessToken;
    const before = (
      await api.database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")
    )[0].next_seq;
    const response = await api.request('/admin/instruments/ABC/resume', 'POST', admin);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RECOVERY_MISMATCH');
    expect(
      (await api.database().query("SELECT status FROM instrument_state WHERE instrument='ABC'"))[0]
        .status,
    ).toBe('halted');
    expect((await api.submit(token)).status).toBe(503);
    expect((await api.request(`/orders/${commands[2].order_id}`, 'DELETE', token)).status).toBe(
      503,
    );
    expect(
      (await api.database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'"))[0]
        .next_seq,
    ).toBe(before);
    if (fault === 'applied-ahead')
      await api
        .database()
        .query("UPDATE order_commands SET applied_at=NULL WHERE instrument='ABC' AND seq=3");
    else if (fault === 'counter-behind')
      await api.database().query("UPDATE instruments SET next_seq=3 WHERE symbol='ABC'");
    else
      await api.database().query(
        `INSERT INTO order_commands(instrument,seq,type,order_id,user_id,payload,accepted_at,applied_at,result,traceparent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          removed.instrument,
          removed.seq,
          removed.type,
          removed.order_id,
          removed.user_id,
          removed.payload,
          removed.accepted_at,
          removed.applied_at,
          removed.result,
          removed.traceparent,
        ],
      );
    expect((await api.request('/admin/instruments/ABC/resume', 'POST', admin)).status).toBe(200);
    await waitFor(
      async () =>
        (
          await api
            .database()
            .query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'")
        )[0].last_applied_seq === '3',
    );
    expect(
      (
        await api
          .database()
          .query('SELECT seq FROM order_commands WHERE applied_at IS NOT NULL ORDER BY seq')
      ).map((row: { seq: string }) => row.seq),
    ).toEqual(['1', '2', '3']);
  },
);
