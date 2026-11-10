import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { NextRequest } from 'next/server';

const origin = 'http://localhost:3000';
const backend = 'http://localhost:3001';
const cookie = 'exchange_access=access';
type Handler = (request: NextRequest) => Promise<Response> | Response;
type ProxyHandler = (
  request: NextRequest,
  context: { params: { path: string[] } },
) => Promise<Response>;
const routes = () => ({
  engine: require('../app/api/engine/[...path]/route') as Record<
    'GET' | 'POST' | 'DELETE',
    ProxyHandler
  >,
  login: require('../app/api/auth/login/route') as { POST: Handler },
  token: require('../app/api/auth/ws-token/route') as { POST: Handler },
});

function request(path: string, method: string, headers: Record<string, string> = {}) {
  return new NextRequest(origin + path, {
    method,
    headers: { host: 'localhost:3000', cookie, ...headers },
    body: method === 'POST' ? '{}' : undefined,
  });
}

describe('frontend route handlers', () => {
  afterEach(() => mock.restoreAll());

  it('accepts mutations only from the same origin', async () => {
    const { engine, login, token } = routes();
    mock.method(globalThis, 'fetch', async () =>
      Response.json({ accessToken: 'access', refreshToken: 'refresh' }),
    );
    const order = { params: { path: ['orders'] } };
    const orderId = { params: { path: ['orders', 'id'] } };
    for (const [path, method, handler] of [
      ['/api/engine/orders', 'POST', (req: NextRequest) => engine.POST(req, order)],
      ['/api/engine/orders/id', 'DELETE', (req: NextRequest) => engine.DELETE(req, orderId)],
      ['/api/auth/login', 'POST', login.POST],
      ['/api/auth/ws-token', 'POST', token.POST],
    ] as const) {
      assert.equal(
        (await handler(request(path, method, { origin: 'https://foreign.test' }))).status,
        403,
        path,
      );
      assert.equal((await handler(request(path, method))).status, 403, path);
      const valid = await handler(request(path, method, { origin }));
      assert.ok(valid.status >= 200 && valid.status < 300, path);
    }
    assert.equal('GET' in token, false, 'App Router must return 405 for GET');
  });

  it('rejects private paths and forwards only allowlisted headers', async () => {
    const { engine } = routes();
    const fetch = mock.method(
      globalThis,
      'fetch',
      async (_url: string, _options: RequestInit) => new Response(null, { status: 200 }),
    );
    for (const [path, status] of [
      [['internal', 'trades'], 404],
      [['metrics'], 404],
      [['admin', 'chaos'], 404],
      [['orders', '..%2Finternal'], 400],
    ] as const) {
      const url = '/api/engine/' + path.join('/');
      assert.equal(
        (await engine.GET(request(url, 'GET'), { params: { path: [...path] } })).status,
        status,
        url,
      );
    }
    assert.equal(fetch.mock.callCount(), 0);

    const path = ['orders'];
    const req = request('/api/engine/orders', 'GET', {
      'x-internal-token': 'untrusted',
      'x-forwarded-for': '1.2.3.4, 127.0.0.1',
      authorization: 'Bearer forged',
    });
    assert.equal((await engine.GET(req, { params: { path } })).status, 200);
    assert.equal(fetch.mock.callCount(), 1);
    const [url, options] = fetch.mock.calls[0].arguments;
    assert.equal(String(url), backend + '/orders');
    assert.deepEqual(Object.fromEntries(new Headers(options?.headers)), {
      authorization: 'Bearer access',
      'x-forwarded-for': '127.0.0.1',
    });
  });
});
