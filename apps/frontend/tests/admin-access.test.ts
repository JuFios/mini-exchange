import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { adminAccess, adminView } from '../lib/admin-access';
import { withoutRecoveredMarker } from '../lib/recovered-marker';
import { recoverSession } from '../lib/client-api';

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

  it('reports a session that the engine no longer accepts apart from a failed check', async () => {
    // Сесію відкликано, а JWT ще чинний: middleware його пропускає, engine відповідає 401.
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
    assert.equal(await adminAccess(admin), 'unauthenticated');
  });

  it('reports an unknown role when the engine fails or does not answer in time', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
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

  it('opens the status page for an admin and with a warning when the role is unknown', () => {
    assert.equal(adminView('admin', false), 'status');
    // Дані сторінки backend віддає лише адміну, тож без відповіді engine показ безпечний,
    // а під час збою engine сторінка й потрібна.
    assert.equal(adminView('unknown', false), 'unverified');
    assert.equal(adminView('forbidden', false), 'denied');
  });

  it('recovers a rejected session once and then signs in again', () => {
    assert.equal(adminView('unauthenticated', false), 'recover');
    // Після вдалого оновлення сесії engine знову відповів 401: новий вхід, а не цикл.
    assert.equal(adminView('unauthenticated', true), 'login');
  });
});

it('drops the recovery marker so that it applies to one page load only', () => {
  assert.equal(
    withoutRecoveredMarker('http://localhost:3000/admin/status?recovered=1'),
    '/admin/status',
  );
  assert.equal(
    withoutRecoveredMarker('http://localhost:3000/admin/status?a=1&recovered=1#x'),
    '/admin/status?a=1#x',
  );
  assert.equal(withoutRecoveredMarker('http://localhost:3000/admin/status'), undefined);
});

describe('session recovery after a rejected server-side check', () => {
  afterEach(() => {
    mock.restoreAll();
    Reflect.deleteProperty(globalThis, 'window');
  });
  const browser = () => {
    const assign = mock.fn();
    Object.assign(globalThis, { window: { location: { assign } } });
    return assign;
  };

  it('refreshes the session with the same request as the API reads', async () => {
    const assign = browser();
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    assert.equal(await recoverSession(), 'refreshed');
    assert.equal(fetch.mock.calls[0].arguments[0], '/api/auth/refresh');
    assert.equal(assign.mock.callCount(), 0);
  });

  it('sends a revoked session to the login page', async () => {
    const assign = browser();
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
    assert.equal(await recoverSession(), 'signed-out');
    assert.deepEqual(assign.mock.calls[0].arguments, ['/login']);
  });

  it('keeps the session when the refresh fails for another reason', async () => {
    const assign = browser();
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
    assert.equal(await recoverSession(), 'failed');
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await recoverSession(), 'failed');
    assert.equal(assign.mock.callCount(), 0);
  });
});
