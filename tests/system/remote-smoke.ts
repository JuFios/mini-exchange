import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, Page } from 'playwright';

const root = resolve(__dirname, '../..');
const project = `exchange-remote-${randomBytes(6).toString('hex')}`;
const temporary = mkdtempSync(resolve(tmpdir(), 'exchange-remote-'));
const logs = process.env.TEST_LOG_DIR ?? mkdtempSync(resolve(tmpdir(), 'exchange-remote-logs-'));
mkdirSync(logs, { recursive: true });
const envFile = resolve(temporary, 'remote.env');
const overlay = resolve(temporary, 'compose.yml');
const nginxImage =
  'nginx:1.30.6-alpine@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a';
const composeArgs = [
  'compose',
  '--env-file',
  envFile,
  '-p',
  project,
  '-f',
  resolve(root, 'docker-compose.yml'),
  '-f',
  resolve(root, 'docker-compose.remote.yml'),
  '-f',
  overlay,
];

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function compose(args: string[]): string {
  return docker([...composeArgs, ...args]);
}

async function until(test: () => Promise<boolean> | boolean, budget = 15000) {
  const end = performance.now() + budget;
  while (performance.now() < end) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Remote assertion timed out after ${budget} ms`);
}

function ownContainer(service: string): string {
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(ids.length, 1);
  const [container] = JSON.parse(docker(['inspect', ids[0]]));
  assert.equal(container.Config.Labels['com.docker.compose.project'], project);
  assert.equal(container.Config.Labels['com.docker.compose.service'], service);
  return ids[0];
}

async function submit(page: Page, side: string, quantity: string) {
  await page
    .getByRole('group', { name: 'Сторона заявки' })
    .getByRole('button', {
      name: side === 'sell' ? 'Продаж' : 'Купівля',
      exact: true,
    })
    .click();
  await page.getByLabel('Ціна', { exact: true }).fill('913.37');
  await page.getByLabel('Кількість', { exact: true }).fill(quantity);
  for (let attempt = 0; attempt < 8; attempt++) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/engine/orders' &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Подати заявку', exact: true }).click(),
    ]);
    const body = await response.json();
    if ([200, 201, 202].includes(response.status())) return body.order.id as string;
    assert(
      [429, 502, 503, 504].includes(response.status()),
      JSON.stringify({ status: response.status(), body }),
    );
    // Форма зберігає той самий ключ до підтвердження, тому retry під час failover не дублює заявку.
    await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** attempt, 1600)));
  }
  throw new Error('Remote submit did not recover within the failover budget');
}

async function browserSmoke(origin: string) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE && { executablePath: process.env.BROWSER_EXECUTABLE }),
  });
  const errors: string[] = [];
  let instance: string | undefined;
  const wss = new Set<string>();
  try {
    const seller = await browser.newContext({ ignoreHTTPSErrors: true });
    const buyer = await browser.newContext({ ignoreHTTPSErrors: true });
    const a = await seller.newPage();
    const b = await buyer.newPage();
    a.on('pageerror', (error) => errors.push(error.message));
    a.on('console', (message) => {
      if (/Refused to|Content Security Policy/.test(message.text())) errors.push(message.text());
    });
    a.on('websocket', (socket) => {
      wss.add(socket.url());
      socket.on('framereceived', ({ payload }) => {
        const found = String(payload).match(/"instance":"(engine-[12])"/);
        if (found) instance = found[1];
      });
    });
    const password = `remote-test-${randomBytes(16).toString('hex')}`;
    async function register(page: Page) {
      const email = `${randomUUID()}@remote.test`;
      const response = await page.goto(origin + '/register');
      assert.equal(response?.status(), 200);
      assert.match((await response!.allHeaders())['content-security-policy'], /nonce-/);
      await page.getByLabel('Електронна пошта').fill(email);
      await page.getByLabel('Пароль', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Зареєструватися', exact: true }).click();
      await page.waitForURL('**/exchange/ABC');
      await page.locator('[data-status="live"]').waitFor();
      return email;
    }
    const email = await register(a);
    await register(b);
    const cookies = await seller.cookies();
    for (const name of ['__Host-exchange_access', '__Host-exchange_refresh']) {
      const cookie = cookies.find((cookie) => cookie.name === name);
      assert(cookie?.secure && cookie.httpOnly && cookie.path === '/' && cookie.sameSite === 'Lax');
    }
    assert.equal(await a.evaluate(() => document.cookie.includes('__Host-exchange')), false);
    // Перевіряємо окремий вхід тим самим шляхом TLS і браузерні cookie після нього.
    await a.goto(origin + '/login');
    await a.getByLabel('Електронна пошта').fill(email);
    await a.getByLabel('Пароль', { exact: true }).fill(password);
    await a.getByRole('button', { name: 'Увійти', exact: true }).click();
    await a.waitForURL('**/exchange/ABC');
    await a.locator('[data-status="live"]').waitFor();
    await submit(a, 'sell', '0.5');
    await a.getByText('Відкрита', { exact: true }).waitFor();
    await submit(b, 'buy', '0.25');
    await a.getByText('Частково виконана', { exact: true }).waitFor();
    assert(wss.size > 0 && [...wss].every((url) => url.startsWith('wss://')));
    await until(() => instance !== undefined);
    const previous = instance!;
    const id = ownContainer(`matching-engine-${previous.endsWith('1') ? '1' : '2'}`);
    docker(['kill', id]);
    try {
      await until(() => instance !== previous, 15000);
      await a.locator('[data-status="live"]').waitFor();
      await submit(b, 'buy', '0.25');
      await a.getByRole('button', { name: /Виконані/ }).click();
      await a.getByText('Виконана', { exact: true }).waitFor();
    } finally {
      docker(['start', id]);
    }
    await until(async () => {
      const row = await a.locator('.wallets tr').filter({ hasText: 'ABC' }).textContent();
      return row !== null && /999\.5/.test(row);
    });
    const hidden = await a.evaluate(async () => ({
      internal: (await fetch('/api/engine/internal/trades')).status,
      csrf: (await fetch('/api/auth/ws-token', { method: 'GET' })).status,
    }));
    assert.equal(hidden.internal, 404);
    assert.equal(hidden.csrf, 405);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        project,
        checks: 12,
        secureCookies: 2,
        wssConnections: wss.size,
        reconnectedFrom: previous,
        reconnectedTo: instance,
        productionPrivateState: 'filled and wallet converged',
      }),
    );
    await a.screenshot({ path: resolve(logs, 'remote-browser.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `https://localhost:${port}`;
  const secrets = Object.fromEntries(
    [
      'POSTGRES_PASSWORD',
      'ENGINE_DB_PASSWORD',
      'LEDGER_DB_PASSWORD',
      'REDIS_PASSWORD',
      'REDIS_ENGINE_PASSWORD',
      'REDIS_SETTLEMENT_PASSWORD',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'RESERVATION_API_TOKEN',
      'RECONCILIATION_TOKEN',
      'OUTBOX_READ_TOKEN',
      'INGRESS_TOKEN',
      'FRONTEND_PROXY_TOKEN',
      'ADMIN_PASSWORD',
    ].map((key) => [key, randomBytes(32).toString('base64url')]),
  );
  const settings = {
    ...secrets,
    ADMIN_EMAILS: 'admin@remote.test',
    PUBLIC_ORIGIN: origin,
    CORS_ORIGINS: origin,
    ENGINE_PUBLIC_WS_URL: origin.replace('https:', 'wss:'),
    TRUSTED_TLS_PROXY_IP: '127.0.0.1',
  };
  const saveEnv = () =>
    writeFileSync(
      envFile,
      Object.entries(settings)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  saveEnv();
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      resolve(temporary, 'key.pem'),
      '-out',
      resolve(temporary, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(
    resolve(temporary, 'nginx.conf'),
    `server {
    listen 443 ssl;
    ssl_certificate /certs/cert.pem;
    ssl_certificate_key /certs/key.pem;
    client_header_timeout 10s;
    client_body_timeout 10s;
    resolver 127.0.0.11 valid=5s;
    location /socket.io/ {
      set $engine http://engine-lb:3001;
      proxy_pass $engine;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
      proxy_read_timeout 60s;
    }
    location / {
      set $frontend http://engine-lb:3000;
      proxy_pass $frontend;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
    }
  }`,
  );
  writeFileSync(
    overlay,
    `services:
  exchange-db:
    ports: !reset []
    volumes: !override ['remote-db-data:/var/lib/postgresql/data']
  redis:
    ports: !reset []
    volumes: ['remote-redis-data:/data']
  settlement-service:
    ports: !reset []
  engine-lb:
    ports: !reset []
  tls-proxy:
    image: ${nginxImage}
    ports: ['127.0.0.1:${port}:443']
    volumes:
      - '${temporary}/nginx.conf:/etc/nginx/conf.d/default.conf:ro'
      - '${temporary}/cert.pem:/certs/cert.pem:ro'
      - '${temporary}/key.pem:/certs/key.pem:ro'
volumes: !override
  remote-db-data:
  remote-redis-data:
`,
  );
  let started = false;
  try {
    console.log(`Remote project: ${project}; logs: ${logs}`);
    started = true;
    compose(['up', '-d', '--no-deps', 'tls-proxy']);
    const [proxy] = JSON.parse(docker(['inspect', ownContainer('tls-proxy')]));
    settings.TRUSTED_TLS_PROXY_IP = proxy.NetworkSettings.Networks[`${project}_default`].IPAddress;
    saveEnv();
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '240']);
    for (const service of ['matching-engine-1', 'matching-engine-2']) ownContainer(service);
    await browserSmoke(origin);
  } finally {
    if (started) {
      try {
        writeFileSync(resolve(logs, 'compose.log'), compose(['logs', '--no-color']));
      } catch (error) {
        console.error('Could not collect Compose logs', error);
      }
      // Випадковий project належить лише цьому запуску; діагностику збережено до cleanup.
      const ids = compose(['ps', '-aq']).trim().split('\n').filter(Boolean);
      for (const id of ids) {
        const [container] = JSON.parse(docker(['inspect', id]));
        assert.equal(container.Config.Labels['com.docker.compose.project'], project);
      }
      const volumes = docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ])
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const volume of volumes) {
        const [metadata] = JSON.parse(docker(['volume', 'inspect', volume]));
        assert.equal(metadata.Labels['com.docker.compose.project'], project);
      }
      compose(['down', '-v', '--remove-orphans']);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
