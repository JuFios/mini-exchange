import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { container, docker, engine, request, until } from './helpers';

const frontend = 'http://frontend:3000';
const login = (base = frontend, headers: Record<string, string> = {}) =>
  request(
    '/api/auth/login',
    'POST',
    undefined,
    {
      email: `${randomUUID()}@system.test`,
      password: 'invalid-test-password',
    },
    base,
    { origin: base, ...headers },
  );

async function checkIngressCapacity() {
  // Повні заголовки й неповне тіло утримують слот nginx без навантаження на bcrypt або PG.
  const clients = Array.from({ length: 64 }, () =>
    createConnection({ host: 'engine-public', port: 3001 }),
  );
  try {
    await Promise.all(
      clients.map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.on('error', reject);
            socket.once('connect', () => {
              socket.write(
                'POST /auth/login HTTP/1.1\r\nHost: engine-public:3001\r\nContent-Length: 100\r\n\r\n{',
              );
              resolve();
            });
          }),
      ),
    );
    await until(
      async () => (await request('/instruments')).status,
      (status) => status === 429,
      3000,
    );
    assert.equal((await request('/instruments/XYZ/book')).status, 200);
    assert.equal((await request('/orders/book?instrument=XYZ')).status, 200);
    assert.equal((await request('/orders')).status, 401);
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/ready')).status, 404);
  } finally {
    for (const socket of clients) socket.destroy();
  }
  await until(
    async () => (await request('/instruments')).status,
    (status) => status === 200,
    3000,
  );
}

async function checkWebSocketCapacity() {
  const sockets: Duplex[] = [];
  const upgrade = () =>
    new Promise<number>((resolve, reject) => {
      const pending = httpRequest(
        engine + '/socket.io/?EIO=4&transport=websocket',
        {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          },
          signal: AbortSignal.timeout(5000),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      pending.once('error', reject);
      pending.once('upgrade', (response, socket) => {
        socket.on('error', () => socket.destroy());
        sockets.push(socket);
        resolve(response.statusCode!);
      });
      pending.end();
    });
  const close = () => sockets.splice(0).forEach((socket) => socket.destroy());
  try {
    // Чекаємо всіх upgrade перед cleanup, навіть якщо одна спроба відхилена.
    const opened = await Promise.allSettled(Array.from({ length: 64 }, upgrade));
    assert(opened.every((result) => result.status === 'fulfilled' && result.value === 101));
    assert.equal(await upgrade(), 429);
    close();
    await until(upgrade, (status) => status === 101, 3000);
  } finally {
    close();
  }
}

async function main() {
  if (process.argv.includes('--peer')) {
    const ip = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    const response = await login();
    assert([200, 401].includes(response.status));
    console.log(JSON.stringify({ ip, status: response.status }));
    return;
  }

  const image = docker('inspect', '--format', '{{.Image}}', hostname());
  const network = docker(
    'inspect',
    '--format',
    '{{range $name, $config := .NetworkSettings.Networks}}{{$name}}{{"\\n"}}{{end}}',
    hostname(),
  )
    .split('\n')
    .find((name) => name.endsWith('_frontend'));
  assert(network, 'Missing frontend network');
  const peer = promisify(execFile)('docker', [
    'run',
    '--rm',
    '--network',
    network,
    image,
    'npm',
    'run',
    '--silent',
    'rate-limit',
    '--',
    '--peer',
  ]);
  const burst = (async () => {
    for (let index = 0; index < 11; index++) {
      const response = await login();
      if (index < 10)
        assert([200, 401].includes(response.status), `Request ${index + 1}: ${response.status}`);
      else {
        assert.equal(response.status, 429);
        assert(Number(response.headers.get('retry-after')) > 0);
      }
    }
  })();
  const [{ stdout }] = await Promise.all([peer, burst]);
  const result = JSON.parse(stdout) as { ip: string; status: number };
  assert(result.ip);
  const forged = await request(
    '/auth/login',
    'POST',
    undefined,
    {
      email: `${randomUUID()}@system.test`,
      password: 'invalid-test-password',
    },
    undefined,
    { 'x-forwarded-for': result.ip },
  );
  assert.equal(forged.status, 429);
  const networks = JSON.parse(
    docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', container('engine-lb')),
  ) as Record<string, { IPAddress: string }>;
  const internalSpoof = await fetch(`http://${networks[network].IPAddress}:8080/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': result.ip },
    body: JSON.stringify({
      email: `${randomUUID()}@system.test`,
      password: 'invalid-test-password',
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(internalSpoof.status, 429);
  assert.equal(
    (
      await login('http://engine-public:3000', {
        'x-forwarded-for': result.ip,
      })
    ).status,
    429,
  );
  await checkIngressCapacity();
  await checkWebSocketCapacity();
  console.log(
    `clientA=10+429 clientB=${result.status} forgedEngine=429 forgedFrontend=429 ingressSlots=64 book=200 ws=64+429 released=101`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
