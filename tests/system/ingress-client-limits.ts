import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { createConnection, Socket } from 'node:net';
import {
  cancelOrder,
  cleanup,
  container,
  docker,
  request,
  token,
  until,
  waitReady,
} from './helpers';

// Адреса клієнта B: `engine-public` є лише в мережі frontend.
const frontend = 'http://engine-public:3000';
const internal = 'http://engine-lb:8080';
const SLOW_BODIES = 64;
const FLOOD_CONNECTIONS = 100;
const SUBMITS = 30;
// Ті самі межі, що й для потоку читань заявок: без ліміту на `:3000` потік читань гаманців
// одного клієнта піднімав медіану заявки іншого через BFF з ~50 мс до ~0,9 с.
const P50_BOUND_MS = 200;
const P95_BOUND_MS = 600;

type Counts = Record<string, number>;
type Mode = 'wallets' | 'config' | 'static';

const percentile = (values: number[], share: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

/**
 * Адреса engine-lb у backend-мережі. З'єднання до неї йде з адреси harness у цій мережі
 * (клієнт A), а не з адреси в мережі frontend, як запити до `engine-public` (клієнт B).
 */
function backendAddress() {
  const networks = JSON.parse(
    docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', container('engine-lb')),
  ) as Record<string, { IPAddress: string }>;
  const address = Object.entries(networks).find(([name]) => name.endsWith('_default'))?.[1]
    .IPAddress;
  assert(address, 'Missing engine-lb address on the backend network');
  return address;
}

/** Запит від клієнта A: на IP з `Host`, який nginx приймає. */
function statusFrom(address: string, port: number, path: string, headers = {}, agent?: Agent) {
  return new Promise<number>((resolve, reject) => {
    const pending = httpRequest(
      {
        host: address,
        port,
        path,
        headers: { host: `engine-public:${port}`, ...headers },
        agent: agent ?? false,
        timeout: 10000,
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode!));
      },
    );
    pending.once('error', reject);
    pending.once('timeout', () => pending.destroy(new Error('Request timed out')));
    pending.end();
  });
}

/** Повні заголовки й неповне тіло тримають слот ліміту з'єднань без навантаження на engine. */
function holdSlowBodies(address: string) {
  return Promise.all(
    Array.from(
      { length: SLOW_BODIES },
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = createConnection({ host: address, port: 3001 });
          socket.once('error', reject);
          socket.once('connect', () => {
            socket.on('error', () => undefined);
            socket.write(
              'POST /auth/login HTTP/1.1\r\nHost: engine-public:3001\r\n' +
                'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
            );
            resolve(socket);
          });
        }),
    ),
  );
}

/** Потік через `:3000` від клієнта A в окремому процесі, щоб не впливати на виміри заявок. */
async function flood(mode: Mode, address: string, accessToken: string) {
  const agent = new Agent({ keepAlive: true, maxSockets: FLOOD_CONNECTIONS });
  const counts: Counts = {};
  let running = true;
  process.on('message', () => {
    running = false;
  });
  // Відсутній статичний файл: Next рендерить на нього HTML-сторінку 404.
  const path = (index: number) =>
    mode === 'wallets'
      ? '/api/settlement/wallets'
      : mode === 'config'
        ? '/api/config'
        : `/_next/static/chunks/missing-${process.pid}-${index}.js`;
  const headers = mode === 'wallets' ? { cookie: 'exchange_access=' + accessToken } : {};
  let completed = 0;
  let started = 0;
  await Promise.all(
    Array.from({ length: FLOOD_CONNECTIONS }, async () => {
      let first = true;
      while (running) {
        let key: string;
        try {
          key = String(await statusFrom(address, 3000, path(completed), headers, agent));
        } catch (error) {
          key = (error as Error).message;
        }
        counts[key] = (counts[key] ?? 0) + 1;
        completed++;
        // Заміри починаються, коли кожне з'єднання потоку вже отримало відповідь.
        if (first) {
          first = false;
          if (++started === FLOOD_CONNECTIONS) process.send!('ready');
        }
      }
    }),
  );
  agent.destroy();
  process.send!(counts, () => process.disconnect());
}

function startFlood(mode: Mode, address: string, accessToken: string) {
  const child: ChildProcess = fork(__filename, ['--flood', mode, address, accessToken], {
    execArgv: ['--require', 'ts-node/register'],
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', () => undefined);
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (value) => value === 'ready' && resolve());
    void exited.then(() => reject(new Error('Flood process exited before it started')));
    setTimeout(() => reject(new Error('Flood did not start within 30 s')), 30000).unref();
  });
  return {
    ready,
    async stop(): Promise<Counts> {
      const counts = new Promise<Counts>((resolve, reject) => {
        child.on('message', (value) => typeof value === 'object' && resolve(value as Counts));
        void exited.then(() => reject(new Error('Flood process exited before reporting')));
      });
      if (child.connected) child.send('stop', () => undefined);
      const result = await counts;
      await exited;
      return result;
    },
    kill: () => child.kill('SIGKILL'),
  };
}

async function main() {
  for (const service of ['matching-engine-1', 'matching-engine-2']) await waitReady(service);
  const address = backendAddress();
  const password = 'system-user-password';
  const newUser = async () => {
    const email = `${randomUUID()}@system.test`;
    return { email, accessToken: await token('register', email, password) };
  };
  const floods: ReturnType<typeof startFlood>[] = [];
  const placed: [string, string][] = [];
  let sockets: Socket[] = [];
  let failure: unknown;
  let price = 900;

  const bffLogin = (email: string) =>
    request('/api/auth/login', 'POST', undefined, { email, password }, frontend, {
      origin: frontend,
    });

  try {
    // Клієнт A займає всі свої слоти. Клієнт B на обох listener і через BFF їх не втрачає.
    const user = await newUser();
    sockets = await holdSlowBodies(address);
    const own = await until(
      () => statusFrom(address, 3001, '/instruments'),
      (status) => status === 429,
      5000,
    );
    const other = {
      instruments: (await request('/instruments')).status,
      internalInstruments: (await request('/instruments', 'GET', undefined, undefined, internal))
        .status,
      register: (
        await request('/auth/register', 'POST', undefined, {
          email: `${randomUUID()}@system.test`,
          password,
        })
      ).status,
      login: (await request('/auth/login', 'POST', undefined, { email: user.email, password }))
        .status,
      bffLogin: (await bffLogin(user.email)).status,
    };
    for (const socket of sockets.splice(0)) socket.destroy();
    const released = await until(
      () => statusFrom(address, 3001, '/instruments'),
      (status) => status === 200,
      5000,
    );
    console.log(
      `ingress client limits slowBodies=${SLOW_BODIES} own=${own} other=${JSON.stringify(other)} ` +
        `released=${released}`,
    );
    assert.equal(own, 429, 'The slow client did not reach its own connection limit');
    assert.deepEqual(other, {
      instruments: 200,
      internalInstruments: 200,
      register: 201,
      login: 201,
      bffLogin: 204,
    });

    // Потік однієї адреси через `:3000` не сповільнює заявки іншої адреси через BFF.
    const victim = await newUser();
    const flooder = await newUser();
    const victimId = (
      JSON.parse(Buffer.from(victim.accessToken.split('.')[1], 'base64url').toString()) as {
        sub: string;
      }
    ).sub;
    const sell = async () => {
      const started = performance.now();
      const response = await request(
        '/api/orders',
        'POST',
        undefined,
        { instrument: 'XYZ', side: 'sell', price: String(price++), quantity: '0.1' },
        frontend,
        {
          origin: frontend,
          cookie: 'exchange_access=' + victim.accessToken,
          'idempotency-key': randomUUID(),
          // BFF виконує мутацію лише від імені користувача, якого бачить вкладка.
          'x-session-user': victimId,
        },
      );
      const latency = performance.now() - started;
      const text = await response.text();
      assert([201, 202].includes(response.status), `BFF submit: ${response.status} ${text}`);
      placed.push([victim.accessToken, (JSON.parse(text) as { order: { id: string } }).order.id]);
      return latency;
    };
    const baseline: number[] = [];
    for (let i = 0; i < 10; i++) baseline.push(await sell());
    console.log(`ingress client limits baselineP50=${percentile(baseline, 0.5).toFixed(0)}ms`);

    for (const mode of ['wallets', 'config', 'static'] as const) {
      const started = startFlood(mode, address, flooder.accessToken);
      floods.push(started);
      // Потік має розігнатися, перш ніж міряти заявки іншого користувача: фіксована пауза на
      // повільному CI могла б закінчитися раніше, ніж дочірній процес почне слати запити.
      await started.ready;
      const latencies: number[] = [];
      for (let i = 0; i < SUBMITS; i++) latencies.push(await sell());
      const counts = await started.stop();
      floods.pop();
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const p50 = percentile(latencies, 0.5);
      const p95 = percentile(latencies, 0.95);
      console.log(
        `ingress client limits flood=${mode} connections=${FLOOD_CONNECTIONS} requests=${total} ` +
          `statuses=${JSON.stringify(counts)} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
      );
      assert(p50 <= P50_BOUND_MS, `BFF submit p50 ${p50.toFixed(0)} ms under a ${mode} flood`);
      assert(p95 <= P95_BOUND_MS, `BFF submit p95 ${p95.toFixed(0)} ms under a ${mode} flood`);
      const limited = counts['429'] ?? 0;
      assert(limited > total / 2, `Only ${limited} of ${total} ${mode} requests were limited`);
      // Після потоку квота адреси відновлюється.
      await until(
        () =>
          statusFrom(address, 3000, '/api/settlement/wallets', {
            cookie: 'exchange_access=' + flooder.accessToken,
          }),
        (status) => status === 200,
        5000,
      );
    }

    // Ліміт на токен для гаманців на `:8080`: нові адреси клієнта не дають нової квоти.
    const reads = async (tokens: string[]) => {
      const counts: Counts = {};
      await Promise.all(
        Array.from({ length: 150 }, async (_, index) => {
          const response = await request(
            '/settlement/wallets',
            'GET',
            tokens[index % tokens.length],
            undefined,
            internal,
            { 'x-forwarded-for': `10.20.${Math.floor(index / 250)}.${(index % 250) + 1}` },
          );
          await response.arrayBuffer();
          counts[response.status] = (counts[response.status] ?? 0) + 1;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return counts;
    };
    const single = await reads([(await newUser()).accessToken]);
    const spread = await reads(
      await Promise.all([1, 2, 3].map(async () => (await newUser()).accessToken)),
    );
    console.log(
      `ingress client limits walletToken single=${JSON.stringify(single)} spread=${JSON.stringify(spread)}`,
    );
    assert(
      (single['429'] ?? 0) >= 30,
      'The token limit did not refuse wallet reads beyond its burst',
    );
    assert.deepEqual(spread, { 200: 150 }, 'Three tokens must stay below the wallet limits');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(
      failure,
      () => sockets.forEach((socket) => socket.destroy()),
      ...floods.map((started) => () => started.kill()),
      ...placed.map(
        ([owner, id]) =>
          () =>
            cancelOrder(owner, id),
      ),
    );
  }
}

const [flag, mode, address, accessToken] = process.argv.slice(2);
void (flag === '--flood' ? flood(mode as Mode, address, accessToken) : main()).catch(
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
