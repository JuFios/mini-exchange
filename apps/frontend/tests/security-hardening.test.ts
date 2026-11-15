import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import { backendResponse, sameOrigin } from '../lib/api';
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
  process.env.PUBLIC_ORIGIN = 'https://exchange.example.test';
  assert.equal(
    sameOrigin(
      new Request('http://frontend:3000/api/auth/login', {
        headers: { host: 'exchange.example.test', origin: process.env.PUBLIC_ORIGIN },
      }),
    ),
    true,
  );
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

it('does not rotate the refresh cookie on cross-site or same-site navigation', async () => {
  const access =
    'h.' + Buffer.from(JSON.stringify({ sid: 's', exp: 1 })).toString('base64url') + '.s';
  const fetch = mock.method(globalThis, 'fetch', async () =>
    Response.json({ accessToken: access, refreshToken: 'r' }),
  );
  for (const site of ['cross-site', 'same-site']) {
    const response = await middleware(
      new NextRequest('http://localhost:3000/exchange/ABC', {
        headers: {
          host: 'localhost:3000',
          cookie: `exchange_access=${access}; exchange_refresh=r`,
          'sec-fetch-site': site,
        },
      }),
    );
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('location'), 'http://localhost:3000/login');
  }
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
  const path = require.resolve('../lib/session');
  const cached = require.cache[path];
  const secure = process.env.COOKIE_SECURE;
  const ws = process.env.ENGINE_PUBLIC_WS_URL;
  try {
    process.env.COOKIE_SECURE = 'true';
    process.env.PUBLIC_ORIGIN = 'https://exchange.example.test';
    process.env.ENGINE_PUBLIC_WS_URL = 'wss://exchange.example.test';
    delete require.cache[path];
    const { setTokens } = require('../lib/session') as {
      setTokens: (
        response: NextResponse,
        tokens: { accessToken: string; refreshToken: string },
      ) => void;
    };
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
    const page = await middleware(new NextRequest('https://exchange.example.test/'));
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
    mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
    const failure = await middleware(
      new NextRequest('https://exchange.example.test/exchange/ABC', {
        headers: { cookie: 'exchange_refresh=expired-session', 'sec-fetch-site': 'same-origin' },
      }),
    );
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally {
    require.cache[path] = cached;
    if (secure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = secure;
    if (ws === undefined) delete process.env.ENGINE_PUBLIC_WS_URL;
    else process.env.ENGINE_PUBLIC_WS_URL = ws;
  }
});
