import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { adminAccess } from '../lib/admin-access';

const token = (claims: Record<string, unknown>) =>
  'h.' +
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString(
    'base64url',
  ) +
  '.s';
const admin = token({ sub: 'admin-1', roles: ['admin'] });

describe('admin access check', () => {
  afterEach(() => mock.restoreAll());

  it('asks the engine before treating a token with the admin claim as admin', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    assert.equal(await adminAccess(admin, '203.0.113.7'), 'admin');
    assert.equal(fetch.mock.callCount(), 1);
    const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'http://localhost:3001/auth/admin');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${admin}`);
    assert.equal(headers.get('x-forwarded-for'), '203.0.113.7');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal, 'The check needs a deadline');
  });

  it('denies access without asking the engine when the token has no admin claim', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    assert.equal(await adminAccess(token({ sub: 'user-1' })), 'forbidden');
    assert.equal(await adminAccess(undefined), 'forbidden');
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('denies access once the engine refuses the role', async () => {
    // Адресу вилучено з ADMIN_EMAILS: claims досі містять роль, а engine відповідає 403.
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
    assert.equal(await adminAccess(admin), 'forbidden');
  });

  it('reports an unknown role when the engine fails or does not answer in time', async () => {
    // 401: сесія скінчилась після middleware; сторінка просить оновити її, а не каже «не адмін».
    for (const status of [401, 429, 500, 502, 503, 504]) {
      mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
      assert.equal(await adminAccess(admin), 'unknown', `status ${status}`);
      mock.restoreAll();
    }
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await adminAccess(admin), 'unknown');
    mock.restoreAll();

    // Запит, що зависає, обривається дедлайном перевірки.
    mock.method(
      globalThis,
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    // Таймер AbortSignal.timeout не тримає цикл подій, а заглушка fetch — теж; сервер тримає.
    const keepAlive = setTimeout(() => undefined, 5000);
    const started = performance.now();
    assert.equal(await adminAccess(admin, undefined, 50), 'unknown');
    clearTimeout(keepAlive);
    assert.ok(performance.now() - started < 1000);
  });
});
