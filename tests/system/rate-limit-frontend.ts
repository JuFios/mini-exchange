import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { docker, request } from './helpers';

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
  console.log(`clientA=10+429 clientB=${result.status} forgedEngine=429 forgedFrontend=429`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
