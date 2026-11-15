import { randomUUID } from 'node:crypto';
import { engineApp } from './engine-app';

const api = engineApp();
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

it('keeps the original absolute refresh expiry after rotation', async () => {
  await api.restart({ JWT_REFRESH_TTL: 60 });
  const response = await api.request('/auth/register', 'POST', undefined, {
    email: `${randomUUID()}@example.test`,
    password: 'strong-test-password',
  });
  const { refreshToken } = await response.json();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
  try {
    const rotated = await api.request('/auth/refresh', 'POST', undefined, { refreshToken });
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect(claims(next.refreshToken).exp).toBe(claims(refreshToken).exp);
    expect(next.refreshToken).not.toBe(refreshToken);
  } finally {
    clock.mockRestore();
  }
});

it('issues a websocket token that cannot authenticate an HTTP request', async () => {
  const access = await api.register();
  const response = await api.request('/auth/ws-token', 'POST', access);
  expect(response.status).toBe(200);
  const { token, userId } = await response.json();
  const payload = claims(token);
  expect(payload).toMatchObject({ sub: userId, typ: 'ws', aud: 'private' });
  expect(payload.exp * 1000 - Date.now()).toBeLessThanOrEqual(60_000);
  expect((await api.request('/orders', 'GET', token)).status).toBe(401);
});

it('omits the counterparty order id from both submit and replay fills', async () => {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  const sold = await (await api.submit(seller)).json();
  const key = randomUUID();
  const submit = () =>
    api.request(
      '/orders',
      'POST',
      buyer,
      { instrument: 'ABC', side: 'buy', price: '100', quantity: '1' },
      { 'Idempotency-Key': key },
    );
  for (const status of [201, 200]) {
    const response = await submit();
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].buyOrderId).toBe(body.order.id);
    expect(body.trades[0]).not.toHaveProperty('sellOrderId');
    expect(JSON.stringify(body.trades)).not.toContain(sold.order.id);
  }
});
