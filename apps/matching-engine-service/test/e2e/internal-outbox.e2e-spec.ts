import { randomUUID } from 'node:crypto';
import { engineApp } from './engine-app';

const api = engineApp();
const read = (path: string, token = process.env.OUTBOX_READ_TOKEN!) =>
  api.request(`/internal/outbox/${path}`, 'GET', undefined, undefined, {
    'x-internal-token': token,
  });

it('separates outbox reads from reconciliation and reservation credentials', async () => {
  for (const token of [
    process.env.RECONCILIATION_TOKEN!,
    process.env.RESERVATION_API_TOKEN!,
    'old-token',
  ])
    expect((await read('page?instrument=ABC', token)).status).toBe(401);
  expect((await read('page?instrument=ABC')).status).toBe(200);
  for (const [token, status] of [
    [process.env.RECONCILIATION_TOKEN!, 401],
    [process.env.OUTBOX_READ_TOKEN!, 200],
  ] as const) {
    const response = await api.request(
      '/INTERNAL/OUTBOX/page?instrument=ABC',
      'GET',
      undefined,
      undefined,
      {
        'x-internal-token': token,
      },
    );
    expect(response.status).toBe(status);
  }
  expect(
    (
      await api.request(
        '/internal/orders/terminal',
        'POST',
        undefined,
        { orderIds: [] },
        { 'x-internal-token': process.env.OUTBOX_READ_TOKEN! },
      )
    ).status,
  ).toBe(401);
});

it('returns only committed financial events and preserves recovery order across redrive', async () => {
  const first = randomUUID();
  const second = randomUUID();
  const tradeId = randomUUID();
  const insert = (id: string, type: string) =>
    api.database().query(
      `INSERT INTO outbox(event_id,stream,type,version,instrument,seq,payload)
     VALUES($1,'exchange:settlement:{ABC}',$2,1,'ABC',1,$3) RETURNING id,settlement_position`,
      [id, type, { tradeId, marker: id }],
    );
  const [before] = await insert(first, 'trade.executed');
  const [later] = await insert(second, 'order.closed');
  const [[updated]] = await api.database().query(
    `UPDATE outbox SET id=nextval(pg_get_serial_sequence('outbox','id')),
      settlement_position=999999 WHERE event_id=$1 RETURNING id,settlement_position`,
    [first],
  );
  expect(BigInt(updated.id)).toBeGreaterThan(BigInt(later.id));
  expect(updated.settlement_position).toBe(before.settlement_position);
  const page = (await (await read('page?instrument=ABC')).json()) as {
    events: { position: string }[];
  };
  expect(page.events.map(({ position }) => position)).toEqual([
    before.settlement_position,
    later.settlement_position,
  ]);
  const canonical = await (await read(`events/${first}`)).json();
  expect(JSON.parse(canonical.envelope)).toMatchObject({
    eventId: first,
    producer: 'matching-engine',
    payload: { marker: first },
  });
  expect((await (await read(`trades/${tradeId}`)).json()).position).toBe(
    before.settlement_position,
  );
  expect((await read(`events/${randomUUID()}`)).status).toBe(404);
  expect((await read('page?instrument=ABC&after=9223372036854775808')).status).toBe(400);
  const id = randomUUID();
  await insert(id, 'order.updated');
  expect((await read(`events/${id}`)).status).toBe(404);
});

it('authorizes compensation only after the durable transition that excludes acceptance', async () => {
  const user = await api.register();
  const response = await api.submit(user);
  const { order } = await response.json();
  expect(await (await read(`compensation/${order.id}`)).json()).toEqual({ allowed: false });
  expect(await (await read(`compensation/${randomUUID()}`)).json()).toEqual({ allowed: false });
  const id = randomUUID();
  await api.database().query(
    `INSERT INTO order_requests(user_id,idempotency_key,request_hash,order_id,status)
     SELECT owner_id,$1,'hash',$2,'releasing' FROM orders WHERE id=$3`,
    [id, id, order.id],
  );
  expect(await (await read(`compensation/${id}`)).json()).toEqual({ allowed: true });
  const [, changed] = await api
    .database()
    .query(`UPDATE order_requests SET status='accepted' WHERE order_id=$1 AND status='reserving'`, [
      id,
    ]);
  expect(changed).toBe(0);
});
