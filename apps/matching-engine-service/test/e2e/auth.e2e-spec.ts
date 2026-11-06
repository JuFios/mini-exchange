import { createHash, randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { engineApp } from './engine-app';

const { request, restart, database } = engineApp();
const jwt = new JwtService();

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

function post(path: string, body: object) {
  return request(`/auth/${path}`, 'POST', undefined, body);
}

async function registerAccount(email = `${randomUUID()}@example.test`) {
  const credentials = { email, password: 'ordinary-account-password' };
  const response = await post('register', credentials);
  expect(response.status).toBe(201);
  return { credentials, tokens: await response.json() as Tokens };
}

async function rotate(refreshToken: string) {
  const response = await post('refresh', { refreshToken });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const tokens = await response.json() as Tokens;
  expect(tokens).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });
  expect(tokens.refreshToken).not.toBe(refreshToken);
  return tokens;
}

it('allows one previous refresh within grace and revokes the session on replay after grace', async () => {
  const { credentials, tokens: first } = await registerAccount();
  const second = await rotate(first.refreshToken);
  const duplicate = await post('refresh', { refreshToken: first.refreshToken });
  expect(duplicate.status).toBe(200);
  const grace = await duplicate.json() as Pick<Tokens, 'accessToken'>;
  expect(grace).toEqual({ accessToken: expect.any(String) });
  expect(grace.accessToken).not.toBe(second.accessToken);

  const [{ refresh_token_hash: currentHash, refresh_prev_hash: previousHash }] = await database().query(
    'SELECT refresh_token_hash, refresh_prev_hash FROM users WHERE email = $1', [credentials.email],
  ) as { refresh_token_hash: string; refresh_prev_hash: string }[];
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  expect(currentHash).toBe(hash(second.refreshToken));
  expect(previousHash).toBe(hash(first.refreshToken));

  await database().query(
    "UPDATE users SET refresh_rotated_at = now() - interval '11 seconds' WHERE email = $1", [credentials.email],
  );
  expect((await post('refresh', { refreshToken: first.refreshToken })).status).toBe(401);
  expect((await post('refresh', { refreshToken: second.refreshToken })).status).toBe(401);
});

it('rotates exactly once across five concurrent refresh requests', async () => {
  const { tokens } = await registerAccount();
  const responses = await Promise.all(Array.from({ length: 5 }, () => post('refresh', { refreshToken: tokens.refreshToken })));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
  const bodies = await Promise.all(responses.map((response) => response.json())) as Partial<Tokens>[];
  const winners = bodies.filter((body) => body.refreshToken !== undefined);
  const duplicates = bodies.filter((body) => body.refreshToken === undefined);
  expect(winners).toEqual([{ accessToken: expect.any(String), refreshToken: expect.any(String) }]);
  expect(duplicates).toEqual(Array.from({ length: 4 }, () => ({ accessToken: expect.any(String) })));
  expect(winners[0].refreshToken).not.toBe(tokens.refreshToken);
});

it('revokes a session when an older refresh token is reused', async () => {
  const { tokens: first } = await registerAccount();
  const second = await rotate(first.refreshToken);
  const third = await rotate(second.refreshToken);
  expect((await post('refresh', { refreshToken: first.refreshToken })).status).toBe(401);
  expect((await post('refresh', { refreshToken: third.refreshToken })).status).toBe(401);
});

it('keeps one refresh session per account: a new login replaces the previous one', async () => {
  const { credentials, tokens: first } = await registerAccount();
  const login = await post('login', credentials);
  expect(login.status).toBe(201);
  const second = await login.json() as Tokens;

  // Попередня сесія вже замінена: її refresh повертає 401, але нову сесію не відкликає.
  expect((await post('refresh', { refreshToken: first.refreshToken })).status).toBe(401);
  expect((await post('logout', { refreshToken: first.refreshToken })).status).toBe(204);
  const third = await rotate(second.refreshToken);
  expect((await post('logout', { refreshToken: second.refreshToken })).status).toBe(204);
  expect((await post('refresh', { refreshToken: third.refreshToken })).status).toBe(401);
  expect((await post('logout', { refreshToken: 'bad-token' })).status).toBe(401);
});

it('logs out the current session when its signed refresh token is presented', async () => {
  const { tokens } = await registerAccount();
  expect((await post('logout', { refreshToken: tokens.refreshToken })).status).toBe(204);
  expect((await post('refresh', { refreshToken: tokens.refreshToken })).status).toBe(401);
});

it('seeds an admin, reserves the address and preserves its password on restart', async () => {
  const email = process.env.ADMIN_EMAILS!;
  const password = process.env.ADMIN_PASSWORD!;
  const rejected = await post('register', { email: email.toUpperCase(), password: 'ordinary-account-password' });
  expect(rejected.status).toBe(409);

  const login = await post('login', { email, password });
  expect(login.status).toBe(201);
  const tokens = await login.json() as Tokens;
  expect(jwt.decode(tokens.accessToken)).toMatchObject({ email, typ: 'access', roles: ['admin'] });

  const changedPassword = 'another-admin-seed-password';
  await restart({ ADMIN_PASSWORD: changedPassword });
  expect((await post('login', { email, password })).status).toBe(201);
  expect((await post('login', { email, password: changedPassword })).status).toBe(401);

  const ordinary = await registerAccount();
  expect(jwt.decode(ordinary.tokens.accessToken)).not.toHaveProperty('roles');
  expect((await request('/orders', 'GET', ordinary.tokens.refreshToken)).status).toBe(401);
  const wrongType = jwt.sign({ sub: randomUUID(), email, typ: 'refresh' }, {
    secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m',
  });
  expect((await request('/orders', 'GET', wrongType)).status).toBe(401);
  expect((await post('refresh', { refreshToken: ordinary.tokens.accessToken })).status).toBe(401);
});

it('rejects startup when an admin address belongs to a regular account', async () => {
  const email = `Existing-${randomUUID()}@example.test`;
  const { credentials } = await registerAccount(email);
  await expect(restart({ ADMIN_EMAILS: [email.toLowerCase()] })).rejects.toThrow(/ADMIN_EMAILS.*regular account/);
  await restart();

  const login = await post('login', credentials);
  expect(login.status).toBe(201);
  expect(jwt.decode((await login.json() as Tokens).accessToken)).not.toHaveProperty('roles');
});

it('rejects startup when the configured instruments differ from the migrated catalog', async () => {
  await expect(restart({ INSTRUMENTS: ['ABC'] })).rejects.toThrow(/INSTRUMENTS.*instruments table/);
});
