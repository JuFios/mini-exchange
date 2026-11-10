import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { docker, request, until } from './helpers';

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
    createConnection({ host: 'engine-lb', port: 3001 }),
  );
  try {
    await Promise.all(
      clients.map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.on('error', reject);
            socket.once('connect', () => {
              socket.write(
                'POST /auth/login HTTP/1.1\r\nHost: engine-lb\r\nContent-Length: 100\r\n\r\n{',
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
    assert.equal((await request('/health')).status, 200);
  } finally {
    for (const socket of clients) socket.destroy();
  }
  await until(
    async () => (await request('/instruments')).status,
    (status) => status === 200,
    3000,
  );
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
    '{{range $name, $config := .NetworkSettings.Networks}}{{$name}}{{end}}',
    hostname(),
  );
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
  assert.equal(
    (await login('http://engine-lb:3000', { 'x-forwarded-for': result.ip })).status,
    429,
  );
  await checkIngressCapacity();
  console.log(
    `clientA=10+429 clientB=${result.status} forgedEngine=429 forgedFrontend=429 ingressSlots=64 book=200`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
