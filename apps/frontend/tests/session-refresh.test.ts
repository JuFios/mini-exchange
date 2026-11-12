import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { NextRequest } from 'next/server';

const origin = 'http://localhost:3000';
const token = (exp: number) =>
  'h.' +
  Buffer.from(
    JSON.stringify({ sub: 'u', sid: '5dfe7681-ea32-49e1-a4bb-7ac31a32da8f', exp }),
  ).toString('base64url') +
  '.s';
const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
const request = (path: string, method: string, access: number, headers = {}) =>
  new NextRequest(origin + path, {
    method,
    headers: {
      host: 'localhost:3000',
      cookie: `exchange_access=${token(inSeconds(access))}; exchange_refresh=r`,
      ...headers,
    },
  });
const passes = (response: Response) => response.headers.get('x-middleware-next') === '1';

describe('refresh away from requests the client may abort', () => {
  afterEach(() => mock.restoreAll());
  const middleware = () =>
    (require('../middleware') as { middleware: (request: NextRequest) => Promise<Response> })
      .middleware;
  const rotated = () =>
    Response.json({ accessToken: token(inSeconds(900)), refreshToken: 'rotated' });

  for (const [state, access] of [
    ['about to expire', 10],
    ['expired', -5],
  ] as const) {
    it(`does not rotate the refresh token on an abortable read whose token is ${state}`, async () => {
      const fetch = mock.method(globalThis, 'fetch', async () => rotated());
      const response = await middleware()(
        request('/api/engine/instruments/ABC/trades', 'GET', access, { 'x-defer-refresh': '1' }),
      );
      assert.ok(passes(response));
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(response.headers.get('set-cookie'), null);
    });
  }

  it('rotates on the dedicated request and answers whether the session is alive', async () => {
    const { POST } = require('../app/api/auth/refresh/route') as {
      POST: (request: NextRequest) => Response;
    };
    const fetch = mock.method(globalThis, 'fetch', async () => rotated());
    const response = await middleware()(request('/api/auth/refresh', 'POST', -5, { origin }));
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(String(fetch.mock.calls[0].arguments[0]), /\/auth\/refresh$/);
    assert.ok(passes(response));
    assert.match(response.headers.get('set-cookie') ?? '', /exchange_refresh=rotated/);

    assert.equal(POST(request('/api/auth/refresh', 'POST', 600, { origin })).status, 204);
    assert.equal(POST(request('/api/auth/refresh', 'POST', -5, { origin })).status, 401);
    assert.equal(POST(request('/api/auth/refresh', 'POST', 600)).status, 403);
  });

  it('does not refresh from another origin', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => rotated());
    await middleware()(
      request('/api/auth/refresh', 'POST', -5, { origin: 'https://foreign.test' }),
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe('session refresh on protected pages', () => {
  afterEach(() => mock.restoreAll());
  const middleware = () =>
    (require('../middleware') as { middleware: (request: NextRequest) => Promise<Response> })
      .middleware;
  const page = (access: number) => request('/exchange/ABC', 'GET', access);

  it('does not rotate the refresh token while the page token is still valid', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () =>
      Response.json({ accessToken: token(inSeconds(900)), refreshToken: 'rotated' }),
    );
    const response = await middleware()(page(10));
    assert.ok(passes(response));
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(response.headers.get('set-cookie'), null);
  });

  it('rotates once the page token has expired', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () =>
      Response.json({ accessToken: token(inSeconds(900)), refreshToken: 'rotated' }),
    );
    const response = await middleware()(page(-5));
    assert.ok(passes(response));
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(response.headers.get('set-cookie') ?? '', /exchange_refresh=rotated/);
  });

  for (const [name, answer] of [
    ['a refresh outage', async () => Response.json({ message: 'busy' }, { status: 503 })],
    [
      'a rate limit',
      async () =>
        Response.json({ message: 'busy' }, { status: 429, headers: { 'retry-after': '5' } }),
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ] as const) {
    it(`keeps the session instead of sending the page to sign-in on ${name}`, async () => {
      mock.method(globalThis, 'fetch', answer);
      const response = await middleware()(page(-5));
      assert.ok([429, 503].includes(response.status), String(response.status));
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    });
  }

  it('sends the page to sign-in when the session is gone', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
    const response = await middleware()(page(-5));
    assert.equal(new URL(response.headers.get('location') ?? '').pathname, '/login');
    assert.match(response.headers.get('set-cookie') ?? '', /exchange_refresh=;/);
  });
});

describe('client session refresh', () => {
  afterEach(() => {
    mock.restoreAll();
    Reflect.deleteProperty(globalThis, 'window');
  });
  const api = () => require('../lib/client-api') as typeof import('../lib/client-api');
  const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

  /** Backend відповідає 401, доки `/api/auth/refresh` не поверне `refresh`. */
  function backend(refresh: () => Promise<Response>) {
    let fresh = false;
    const calls: { path: string; init: RequestInit }[] = [];
    mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      if (path === '/api/auth/refresh') {
        const response = await refresh();
        fresh = response.ok;
        return response;
      }
      if (init.signal?.aborted) throw aborted();
      return fresh ? Response.json([]) : new Response('{}', { status: 401 });
    });
    const refreshes = () => calls.filter(({ path }) => path === '/api/auth/refresh');
    return { calls, refreshes };
  }
  const login = () => {
    const assign = mock.fn();
    Object.assign(globalThis, { window: { location: { assign, reload: mock.fn() } } });
    return assign;
  };

  it('refreshes once for concurrent reads and repeats them', async () => {
    let finish!: (response: Response) => void;
    const { calls, refreshes } = backend(() => new Promise((resolve) => (finish = resolve)));
    const assign = login();
    const { signal } = new AbortController();

    const reads = ['/api/engine/orders', '/api/settlement/wallets', '/api/engine/orders/1'].map(
      (path) => api().checkedFetch(path, { signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    finish(new Response(null, { status: 204 }));
    const responses = await Promise.all(reads);

    assert.deepEqual(
      responses.map(({ status }) => status),
      [200, 200, 200],
    );
    assert.equal(refreshes().length, 1);
    assert.equal(refreshes()[0].init.method, 'POST');
    assert.equal(refreshes()[0].init.signal, undefined);
    assert.equal(calls.length, 7);
    for (const { path, init } of calls)
      assert.equal(
        new Headers(init.headers).has('x-defer-refresh'),
        path !== '/api/auth/refresh',
        path,
      );
    assert.equal(assign.mock.callCount(), 0);
  });

  it('lets the refresh finish when the read that asked for it is aborted', async () => {
    let finish!: (response: Response) => void;
    const { refreshes } = backend(() => new Promise((resolve) => (finish = resolve)));
    const assign = login();
    const reading = new AbortController();

    const read = api().checkedFetch('/api/engine/instruments/ABC/trades', {
      signal: reading.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    reading.abort();
    finish(new Response(null, { status: 204 }));

    await assert.rejects(read, { name: 'AbortError' });
    assert.equal(refreshes().length, 1);
    assert.equal(assign.mock.callCount(), 0);
    // Наступне читання вже має оновлену сесію й нового refresh не запускає.
    const { signal } = new AbortController();
    assert.equal((await api().checkedFetch('/api/engine/orders', { signal })).status, 200);
    assert.equal(refreshes().length, 1);
  });

  it('goes to the sign-in page only when the refresh says the session is gone', async () => {
    const assign = login();
    const { signal } = new AbortController();

    backend(async () => new Response('{}', { status: 503 }));
    await assert.rejects(api().checkedFetch('/api/engine/orders', { signal }), { status: 503 });
    assert.equal(assign.mock.callCount(), 0);
    mock.restoreAll();

    backend(async () => new Response(null, { status: 401 }));
    await assert.rejects(api().checkedFetch('/api/engine/orders', { signal }), { status: 401 });
    assert.deepEqual(assign.mock.calls[0].arguments, ['/login']);
  });

  it('leaves a request without a signal to the middleware refresh', async () => {
    const { calls, refreshes } = backend(async () => new Response(null, { status: 204 }));
    login();

    await assert.rejects(api().checkedFetch('/api/engine/orders', { method: 'POST' }), {
      status: 401,
    });

    assert.equal(refreshes().length, 0);
    assert.equal(new Headers(calls[0].init.headers).has('x-defer-refresh'), false);
  });
});
