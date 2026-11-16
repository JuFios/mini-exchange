import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { io } from 'socket.io-client';
import { engine, request } from './helpers';

function withHost(port: number, host: string, path = '/health') {
  return new Promise<{ status: number; server: string }>((resolve, reject) => {
    const request = httpRequest(
      `http://engine-lb:${port}${path}`,
      {
        headers: { host },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          server: String(response.headers.server ?? ''),
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  for (const path of ['/docs', '/docs-json', '/DoCs/']) {
    assert.equal((await request(path)).status, 404);
  }
  for (const port of [3000, 3001]) {
    const response = await withHost(port, 'rebind.attacker.test');
    assert.equal(response.status, 421);
    assert.doesNotMatch(response.server, /\d+\.\d+/);
  }
  assert.equal((await withHost(3001, 'localhost:3001')).status, 200);
  assert.equal((await withHost(3000, 'localhost:3001')).status, 421);
  assert.equal((await withHost(3001, 'rebind.attacker.test', '/.engine-lb-error')).status, 404);
  assert.equal((await withHost(3001, 'rebind.attacker.test', '/.ENGINE-LB-ERROR')).status, 421);
  const frontend = 'http://frontend:3000';
  const oversized = await fetch('http://engine-lb:3000/api/auth/login', {
    method: 'POST',
    headers: { origin: 'http://engine-lb:3000', 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(65 * 1024) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(((await oversized.json()) as { statusCode: number }).statusCode, 413);
  const registered = await fetch(frontend + '/api/auth/register', {
    method: 'POST',
    headers: { origin: frontend, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${randomUUID()}@system.test`,
      password: 'security-test-password',
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(registered.status, 204);
  const cookie = registered.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const wallets = await fetch(frontend + '/api/settlement/wallets', {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(wallets.status, 200);
  const response = await fetch(frontend + '/api/auth/ws-token', {
    method: 'POST',
    headers: { origin: frontend, cookie },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const { token, userId } = (await response.json()) as { token: string; userId: string };
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    typ: string;
    aud: string;
    exp: number;
    sub: string;
  };
  assert.equal(claims.typ, 'ws');
  assert.equal(claims.aud, 'private');
  assert.equal(claims.sub, userId);
  assert(claims.exp * 1000 - Date.now() <= 60_000);
  assert.equal((await request('/orders', 'GET', token)).status, 401);
  const socket = io(engine + '/private', {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    timeout: 5000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
  } finally {
    socket.disconnect();
  }
  const nonces = new Set<string>();
  let verifiedScripts = 0;
  for (const path of ['/login', '/register', '/exchange/ABC']) {
    const page = await fetch(frontend + path, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(page.status, 200, path);
    const scriptPolicy =
      (page.headers.get('content-security-policy') ?? '')
        .split(';')
        .find((rule) => rule.trim().startsWith('script-src ')) ?? '';
    const nonce = /'nonce-([^']+)'/.exec(scriptPolicy)?.[1];
    assert(nonce, `Missing CSP nonce on ${path}`);
    assert.doesNotMatch(scriptPolicy, /unsafe-inline/, path);
    assert(!nonces.has(nonce), `Reused CSP nonce on ${path}`);
    nonces.add(nonce);
    const html = await page.text();
    const scripts = [
      ...html.matchAll(/<script(?=[\s>])((?:"[^"]*"|'[^']*'|[^'">])*)>[\s\S]*?<\/script\s*>/gi),
    ];
    assert(scripts.length > 0, `No script elements on ${path}`);
    for (const [index, [, attributes]] of scripts.entries()) {
      const nonceAttribute = [
        ...attributes.matchAll(/\s+([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g),
      ].find(([, name]) => name.toLowerCase() === 'nonce');
      assert.equal(
        nonceAttribute?.[2] ?? nonceAttribute?.[3] ?? nonceAttribute?.[4],
        nonce,
        `${path} script ${index + 1}`,
      );
    }
    verifiedScripts += scripts.length;
    assert.equal(page.headers.get('x-powered-by'), null);
    assert(page.headers.has('permissions-policy'));
  }
  console.log(
    `security boundaries docs=404 host=421 wsHttp=401 wsConnect=ok noncePages=${nonces.size} nonceScripts=${verifiedScripts} headers=ok`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
