import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { internalToken, ledgerApp, tradeFixture } from '../ledger-app';

const ledger = ledgerApp();
const api = () => request(ledger.app().getHttpServer());
const reserve = (reservationId: string, userId: string, asset: string, amount: string) =>
  api()
    .post('/internal/reservations')
    .set('x-internal-token', internalToken)
    .send({ reservationId, userId, asset, amount });
const release = (id: string) =>
  api().post(`/internal/reservations/${id}/release`).set('x-internal-token', internalToken);
const settle = (trade: object) =>
  api().post('/trades/settle').set('x-internal-token', internalToken).send(trade);

it('requires the internal token on all settlement mutation routes', async () => {
  const paths = [
    '/trades/settle',
    '/internal/reservations',
    `/internal/reservations/${randomUUID()}/release`,
  ];
  for (const path of paths) {
    await api().post(path).expect(401);
    await api().post(path).set('x-internal-token', 'x'.repeat(internalToken.length)).expect(401);
    await api().post(path).set('x-internal-token', 'x').expect(401);
  }
});

it('returns only the access token owner balances and rejects userId query overrides', async () => {
  const a = randomUUID();
  const b = randomUUID();
  await reserve(randomUUID(), b, 'USD', '10000000000').expect(201);
  const jwt = new JwtService({ secret: ledger.jwtSecret });
  const access = jwt.sign({ sub: a, typ: 'access' }, { expiresIn: '15m' });
  const secondAccess = jwt.sign({ sub: b, typ: 'access' }, { expiresIn: '15m' });
  const refresh = jwt.sign({ sub: a, typ: 'refresh' }, { expiresIn: '15m' });

  await api()
    .get('/wallets')
    .auth(access, { type: 'bearer' })
    .expect(200, [
      { asset: 'ABC', available: '1000.00000000', reserved: '0.00000000' },
      { asset: 'USD', available: '100000.0000000000', reserved: '0.0000000000' },
      { asset: 'XYZ', available: '1000.00000000', reserved: '0.00000000' },
    ]);
  const other = await api().get('/wallets').auth(secondAccess, { type: 'bearer' }).expect(200);
  expect(other.body[1]).toEqual({
    asset: 'USD',
    available: '99999.0000000000',
    reserved: '1.0000000000',
  });
  await api().get('/wallets').query({ userId: b }).auth(access, { type: 'bearer' }).expect(400);
  await api().get('/wallets').auth(refresh, { type: 'bearer' }).expect(401);
  await api().get('/wallets').expect(401);
});

it('settles the same trade only once and returns a conflict for a changed quantity', async () => {
  const trade = tradeFixture();
  await reserve(trade.buyOrderId, trade.buyerUserId, 'USD', '505000000000').expect(201);
  await reserve(trade.sellOrderId, trade.sellerUserId, 'ABC', '50000000').expect(201);
  const first = await settle(trade).expect(200);
  expect(first.body.status).toBe('applied');
  await settle(trade).expect(200, { status: 'duplicate', entryId: first.body.entryId });
  await settle({ ...trade, quantity: '0.4' }).expect(409);
  const [{ entries }]: { entries: number }[] = await ledger
    .source()
    .query('SELECT count(*)::int AS entries FROM journal_entries WHERE trade_id=$1', [
      trade.tradeId,
    ]);
  expect(entries).toBe(1);
  const [{ legs }]: { legs: number }[] = await ledger
    .source()
    .query('SELECT count(*)::int AS legs FROM postings WHERE entry_id=$1', [first.body.entryId]);
  expect(legs).toBe(5);
});

it('stores rejections and releases or tombstones a reservation only once', async () => {
  const user = randomUUID();
  const rejected = randomUUID();
  const active = randomUUID();
  const unknown = randomUUID();
  await reserve(rejected, user, 'ABC', '100000000001').expect(422);
  await reserve(rejected, user, 'ABC', '100000000001').expect(422);
  await reserve(rejected, user, 'ABC', '1').expect(409);
  await reserve(active, user, 'ABC', '100000000').expect(201);
  await reserve(active, user, 'ABC', '100000000').expect(201);
  await Promise.all([release(active).expect(200), release(active).expect(200)]);
  await release(unknown).expect(200);
  const delayed = await reserve(unknown, user, 'ABC', '100000000').expect(409);
  expect(delayed.body.code).toBe('ALREADY_RELEASED');
  const rows = await ledger
    .source()
    .query('SELECT type FROM journal_entries WHERE reservation_id=$1 ORDER BY id', [active]);
  expect(rows).toEqual([{ type: 'reserve' }, { type: 'release' }]);
  const [{ balance }] = await ledger
    .source()
    .query("SELECT balance FROM accounts WHERE user_id=$1 AND asset='ABC' AND kind='reserved'", [
      user,
    ]);
  expect(balance).toBe('0');
});
