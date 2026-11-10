import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { NextRequest } from 'next/server';

const origin = 'http://localhost:3000';
const token = (claims: Record<string, unknown>) =>
  'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

function request(
  path: string,
  method: string,
  cookie: string,
  headers: Record<string, string> = {},
) {
  return new NextRequest(origin + path, {
    method,
    headers: { host: 'localhost:3000', cookie, ...headers },
    body: method === 'POST' ? '{}' : undefined,
  });
}

describe('session binding in the proxy', () => {
  afterEach(() => mock.restoreAll());
  const engine = () =>
    require('../app/api/engine/[...path]/route') as Record<
      'GET' | 'POST',
      (request: NextRequest, context: { params: { path: string[] } }) => Promise<Response>
    >;
  const cookie = 'exchange_access=' + token({ sub: 'user-a', exp: inSeconds(600) });

  it('refuses a mutation from a tab bound to another user', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 201 }));
    const context = { params: { path: ['orders'] } };
    const stale: Record<string, string>[] = [
      { origin, 'x-session-user': 'user-b' },
      { origin }, // вкладка ще не знає користувача
    ];
    for (const headers of stale) {
      const response = await engine().POST(
        request('/api/engine/orders', 'POST', cookie, headers),
        context,
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'session_changed');
    }
    assert.equal(fetch.mock.callCount(), 0);

    const ok = await engine().POST(
      request('/api/engine/orders', 'POST', cookie, { origin, 'x-session-user': 'user-a' }),
      context,
    );
    assert.equal(ok.status, 201);
    assert.equal(fetch.mock.callCount(), 1);
  });

  it('refuses a read for another user but lets an unbound read pass', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response('[]', { status: 200 }));
    const context = { params: { path: ['orders'] } };
    const other = await engine().GET(
      request('/api/engine/orders', 'GET', cookie, { 'x-session-user': 'user-b' }),
      context,
    );
    assert.equal(other.status, 409);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(
      (await engine().GET(request('/api/engine/orders', 'GET', cookie), context)).status,
      200,
    );
  });

  it('exposes the user id with the websocket token', async () => {
    const { POST } = require('../app/api/auth/ws-token/route') as {
      POST: (request: NextRequest) => Response;
    };
    const body = await POST(request('/api/auth/ws-token', 'POST', cookie, { origin })).json();
    assert.equal(body.userId, 'user-a');
  });
});

describe('token refresh margin', () => {
  afterEach(() => mock.restoreAll());
  const run = (path: string, access: number, refresh: () => Response | Promise<Response>) => {
    const fetch = mock.method(globalThis, 'fetch', async () => refresh());
    const { middleware } = require('../middleware') as {
      middleware: (request: NextRequest) => Promise<Response>;
    };
    const cookie = `exchange_access=${token({ sub: 'u', exp: inSeconds(access) })}; exchange_refresh=r`;
    return { fetch, response: middleware(request(path, 'GET', cookie)) };
  };
  const passes = (response: Response) => response.headers.get('x-middleware-next') === '1';

  it('refreshes a token that would expire before the backend sees it', async () => {
    const tokens = { accessToken: token({ sub: 'u', exp: inSeconds(900) }), refreshToken: 'n' };
    const { fetch, response } = run('/api/engine/orders', 10, () => Response.json(tokens));
    const result = await response;
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(result.headers.get('set-cookie') ?? '', /exchange_access=/);
  });

  it('keeps a still valid token when the early refresh fails', async () => {
    const api = run('/api/engine/orders', 10, () => new Response('{}', { status: 503 }));
    assert.ok(passes(await api.response));
    const page = run('/exchange/ABC', 10, () => new Response('{}', { status: 503 }));
    assert.ok(passes(await page.response), 'the page must not redirect to /login');
  });

  it('does not refresh a token with plenty of time left', async () => {
    const { fetch, response } = run('/api/engine/orders', 300, () => new Response('{}'));
    assert.ok(passes(await response));
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('still reports a failed refresh of an expired token', async () => {
    const { response } = run('/api/engine/orders', -5, () => new Response('{}', { status: 503 }));
    assert.equal((await response).status, 503);
  });
});

describe('forms', () => {
  it('keeps amount fields free of maxLength so a paste is never cut silently', () => {
    const form = readFileSync(join(process.cwd(), 'app', 'components', 'order-form.tsx'), 'utf8');
    assert.doesNotMatch(form, /maxLength/);
  });

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
    });

  it('never submits credentials with the default GET', () => {
    const root = join(process.cwd(), 'app');
    const forms = files(root).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<form\b[^>]*>/g)].map(([tag]) => [file, tag]),
    );
    assert.ok(forms.length >= 2);
    for (const [file, tag] of forms) assert.match(tag, /method="post"/, file);
  });
});
