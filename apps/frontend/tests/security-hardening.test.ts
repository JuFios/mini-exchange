import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import { backendResponse, frontendProxyToken, requestOrigin, sameOrigin } from '../lib/api';
import { middleware } from '../middleware';

afterEach(() => {
  mock.restoreAll();
  delete process.env.PUBLIC_ORIGIN;
});

it('does not accept a rebinding host as the trusted origin', () => {
  for (const origin of ['http://localhost:3000', 'http://rebind.attacker.test:3000']) {
    const request = new Request('http://rebind.attacker.test:3000/api/auth/login', {
      headers: { host: 'rebind.attacker.test:3000', origin },
    });
    assert.equal(sameOrigin(request), false);
  }
});

it('uses the configured public origin behind the TLS proxy', () => {
  process.env.PUBLIC_ORIGIN = 'HTTPS://EXCHANGE.Example.Test:443';
  assert.equal(
    sameOrigin(
      new Request('http://frontend:3000/api/auth/login', {
        headers: { host: 'exchange.example.test', origin: 'https://exchange.example.test' },
      }),
    ),
    true,
  );
});

it('canonicalizes the local allowlist and keeps non-default ports distinct', () => {
  const previous = process.env.PUBLIC_ORIGINS;
  try {
    process.env.PUBLIC_ORIGINS = ' HTTP://LOCALHOST:80, http://localhost, http://LOCALHOST:3000 ';
    for (const origin of ['http://localhost', 'http://localhost:3000']) {
      const request = new Request(origin);
      assert.equal(requestOrigin(request), origin);
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGINS;
    else process.env.PUBLIC_ORIGINS = previous;
  }
});

it('rejects an invalid or demo proxy token in remote mode', () => {
  const secure = process.env.COOKIE_SECURE;
  const proxyToken = process.env.FRONTEND_PROXY_TOKEN;
  try {
    process.env.COOKIE_SECURE = 'true';
    delete process.env.FRONTEND_PROXY_TOKEN;
    assert.throws(frontendProxyToken, /FRONTEND_PROXY_TOKEN/);
    for (const token of ['', 'invalid', 'demo-frontend-proxy-local-only-000001']) {
      process.env.FRONTEND_PROXY_TOKEN = token;
      assert.throws(frontendProxyToken, /FRONTEND_PROXY_TOKEN/);
    }
    process.env.FRONTEND_PROXY_TOKEN = 'remote-frontend-proxy-token-000001';
    assert.equal(frontendProxyToken(), process.env.FRONTEND_PROXY_TOKEN);
  } finally {
    if (secure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = secure;
    if (proxyToken === undefined) delete process.env.FRONTEND_PROXY_TOKEN;
    else process.env.FRONTEND_PROXY_TOKEN = proxyToken;
  }
});

it('replaces upstream HTML errors with a bounded JSON response', async () => {
  const response = backendResponse(
    new Response('<html>nginx/1.28.0</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.doesNotMatch(await response.text(), /nginx|html/);
});

it('refreshes cross-site navigation without rotating the refresh cookie', async () => {
  const expired =
    'h.' + Buffer.from(JSON.stringify({ sid: 's', exp: 1 })).toString('base64url') + '.s';
  const fresh =
    'h.' +
    Buffer.from(
      JSON.stringify({ sid: 's', sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url') +
    '.s';
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ accessToken: fresh }));
  for (const site of ['cross-site', 'same-site']) {
    const response = await middleware(
      new NextRequest('http://localhost:3000/exchange/ABC', {
        headers: {
          host: 'localhost:3000',
          cookie: `exchange_access=${expired}; exchange_refresh=r`,
          'sec-fetch-site': site,
        },
      }),
    );
    const body = JSON.parse(String(fetch.mock.calls.at(-1)?.arguments[1]?.body));
    assert.deepEqual(body, { refreshToken: 'r', rotate: false });
    // Сторінка відкривається без /login, а refresh-cookie лишається тим самим.
    assert.equal(response.headers.get('location'), null);
    const cookies = response.headers.get('set-cookie') ?? '';
    assert.match(cookies, new RegExp(`exchange_access=${fresh.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(cookies, /exchange_refresh=/);
  }
  assert.equal(fetch.mock.callCount(), 2);
});

it('rotates on a same-origin navigation and signs out when the session is gone', async () => {
  const expired =
    'h.' + Buffer.from(JSON.stringify({ sid: 's', exp: 1 })).toString('base64url') + '.s';
  const navigate = (site: string) =>
    middleware(
      new NextRequest('http://localhost:3000/exchange/ABC', {
        headers: {
          host: 'localhost:3000',
          cookie: `exchange_access=${expired}; exchange_refresh=r`,
          'sec-fetch-site': site,
        },
      }),
    );
  const rotated = mock.method(globalThis, 'fetch', async () =>
    Response.json({ accessToken: expired, refreshToken: 'rotated' }),
  );
  await navigate('same-origin');
  assert.deepEqual(JSON.parse(String(rotated.mock.calls[0].arguments[1]?.body)), {
    refreshToken: 'r',
  });
  rotated.mock.restore();
  mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  const response = await navigate('cross-site');
  assert.equal(response.headers.get('location'), 'http://localhost:3000/login');
  assert.match(response.headers.get('set-cookie') ?? '', /exchange_refresh=;/);
});

it('uses a fresh script nonce and passes it to the renderer', async () => {
  const responses = await Promise.all(
    [1, 2].map(() => middleware(new NextRequest('http://localhost:3000/'))),
  );
  const nonces = responses.map((response) => {
    const csp = response.headers.get('content-security-policy') ?? '';
    const scripts = csp.split(';').find((value) => value.trim().startsWith('script-src')) ?? '';
    assert.doesNotMatch(scripts, /unsafe-inline/);
    const nonce = /'nonce-([^']+)'/.exec(scripts)?.[1];
    assert.ok(nonce);
    assert.equal(response.headers.get('x-middleware-request-x-nonce'), nonce);
    assert.equal(response.headers.get('x-middleware-request-content-security-policy'), csp);
    return nonce;
  });
  assert.notEqual(nonces[0], nonces[1]);
});

it('uses host-only secure cookies and HSTS in remote mode', async () => {
  const paths = [require.resolve('../lib/session'), require.resolve('../middleware')];
  const cached = paths.map((path) => require.cache[path]);
  const secure = process.env.COOKIE_SECURE;
  const ws = process.env.ENGINE_PUBLIC_WS_URL;
  const proxyToken = process.env.FRONTEND_PROXY_TOKEN;
  try {
    process.env.COOKIE_SECURE = 'true';
    process.env.PUBLIC_ORIGIN = 'https://exchange.example.test';
    process.env.ENGINE_PUBLIC_WS_URL = 'wss://exchange.example.test';
    process.env.FRONTEND_PROXY_TOKEN = 'remote-frontend-proxy-token-000001';
    for (const path of paths) delete require.cache[path];
    const { setTokens } = require('../lib/session') as {
      setTokens: (
        response: NextResponse,
        tokens: { accessToken: string; refreshToken: string },
      ) => void;
    };
    const { middleware: remoteMiddleware } =
      require('../middleware') as typeof import('../middleware');
    const response = new NextResponse();
    const token =
      'h.' +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString(
        'base64url',
      ) +
      '.s';
    setTokens(response, { accessToken: token, refreshToken: token });
    const cookies = response.cookies.getAll();
    assert.deepEqual(
      cookies.map(({ name }) => name),
      ['__Host-exchange_access', '__Host-exchange_refresh'],
    );
    for (const cookie of cookies) {
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.path, '/');
      assert.equal(cookie.domain, undefined);
    }
    const page = await remoteMiddleware(new NextRequest('https://exchange.example.test/'));
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
    const failure = await remoteMiddleware(
      new NextRequest('https://exchange.example.test/exchange/ABC', {
        headers: {
          cookie: '__Host-exchange_refresh=expired-session',
          'sec-fetch-site': 'same-origin',
        },
      }),
    );
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body)), {
      refreshToken: 'expired-session',
    });
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally {
    paths.forEach((path, index) => {
      require.cache[path] = cached[index];
    });
    if (secure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = secure;
    if (ws === undefined) delete process.env.ENGINE_PUBLIC_WS_URL;
    else process.env.ENGINE_PUBLIC_WS_URL = ws;
    if (proxyToken === undefined) delete process.env.FRONTEND_PROXY_TOKEN;
    else process.env.FRONTEND_PROXY_TOKEN = proxyToken;
  }
});
