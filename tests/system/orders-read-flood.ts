import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cancelOrder, cleanup, engine, request, submit, token, waitReady } from './helpers';

const internal = 'http://engine-lb:8080';
const instrument = 'XYZ';
const CONNECTIONS = 300;
const SUBMITS = 30;
// Без потоку заявка проходить за десятки мілісекунд, а без ліміту потік із 300 з'єднань
// піднімав медіану до ~0,5 с. Межа лишає запас для повільного CI, але ловить цю деградацію.
const P50_BOUND_MS = 200;
const P95_BOUND_MS = 600;

type Counts = Record<string, number>;

const percentile = (values: number[], share: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

// Рядок у формі JWT з випадковим підписом: для nginx це новий токен на кожен запит.
const forged = () => [12, 48, 32].map((size) => randomBytes(size).toString('base64url')).join('.');

/** Потік читань в окремому процесі, щоб його цикл подій не впливав на виміри заявок. */
async function flood(mode: 'token' | 'forged', accessToken: string) {
  const counts: Counts = {};
  let running = true;
  process.on('message', () => {
    running = false;
  });
  const loop = async (index: number) => {
    // Обидва слухачі й обидва маршрути читання в кожній комбінації.
    const base = index % 4 === 0 || index % 4 === 3 ? internal : engine;
    const path = index % 2 ? `/orders/${randomUUID()}` : '/orders?status=all&limit=100';
    while (running) {
      // Підроблені токени чергуються із запитами без токена: обидва не мають ключа токена.
      const bearer = mode === 'token' ? accessToken : index % 3 ? forged() : undefined;
      let key: string;
      try {
        const response = await request(path, 'GET', bearer, undefined, base);
        await response.arrayBuffer();
        key = String(response.status);
      } catch (error) {
        key = (error as Error).name;
      }
      counts[key] = (counts[key] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CONNECTIONS }, (_, index) => loop(index)));
  // Відкритий IPC-канал тримав би процес живим.
  process.send!(counts, () => process.disconnect());
}

function startFlood(mode: 'token' | 'forged', accessToken: string) {
  const child: ChildProcess = fork(__filename, ['--flood', mode, accessToken], {
    execArgv: ['--require', 'ts-node/register'],
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
  });
  // Підписка одразу: процес може впасти ще до `stop`. `close` настає після закриття IPC, тобто
  // після доставки останнього повідомлення, а `exit` може його випередити.
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', () => undefined);
  return {
    async stop(): Promise<Counts> {
      // Процес, що впав, не відповість: це помилка сценарію, а не зависання.
      const counts = new Promise<Counts>((resolve, reject) => {
        child.once('message', (value) => resolve(value as Counts));
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
  const password = 'system-user-password';
  const victim = await token('register', `${randomUUID()}@system.test`, password);
  const flooder = await token('register', `${randomUUID()}@system.test`, password);
  const placed: [string, string][] = [];
  const floods: ReturnType<typeof startFlood>[] = [];
  let failure: unknown;
  let price = 700;

  const sell = async (owner: string) => {
    const started = performance.now();
    const response = await submit(
      owner,
      { instrument, side: 'sell', price: String(price++), quantity: '0.1' },
      engine,
      { key: randomUUID(), retry: false },
    );
    const latency = performance.now() - started;
    const text = await response.text();
    assert([201, 202].includes(response.status), `Submit: ${response.status} ${text}`);
    placed.push([owner, (JSON.parse(text) as { order: { id: string } }).order.id]);
    return latency;
  };

  async function underFlood(mode: 'token' | 'forged', during?: () => Promise<void>) {
    const started = startFlood(mode, flooder);
    floods.push(started);
    const latencies: number[] = [];
    // Потік має розігнатися, перш ніж міряти заявки іншого користувача.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (let i = 0; i < SUBMITS; i++) latencies.push(await sell(victim));
    await during?.();
    const counts = await started.stop();
    floods.pop();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    console.log(
      `orders read flood mode=${mode} connections=${CONNECTIONS} reads=${total} ` +
        `statuses=${JSON.stringify(counts)} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
    );
    assert(p50 <= P50_BOUND_MS, `Submit p50 ${p50.toFixed(0)} ms under a ${mode} read flood`);
    assert(p95 <= P95_BOUND_MS, `Submit p95 ${p95.toFixed(0)} ms under a ${mode} read flood`);
    const limited = counts['429'] ?? 0;
    assert(limited > total / 2, `Only ${limited} of ${total} ${mode} reads were limited`);
    return counts;
  }

  try {
    const baseline: number[] = [];
    for (let i = 0; i < 10; i++) baseline.push(await sell(victim));
    console.log(`orders read flood baselineP50=${percentile(baseline, 0.5).toFixed(0)}ms`);

    let probes: Record<string, number> = {};
    let cors: Record<string, unknown> = {};
    const counts = await underFlood('token', async () => {
      // Ліміт стосується лише читань: власна заявка й скасування того, хто читає, проходять.
      await sell(flooder);
      const [owner, own] = placed.pop()!;
      await cancelOrder(owner, own);
      probes = {
        health: (await request('/health')).status,
        book: (await request('/orders/book?instrument=XYZ', 'GET', flooder)).status,
        // Без внутрішнього токена маршрут відповідає 401; 429 означав би ліміт на перевірці сесії.
        session: (await request('/internal/auth/session', 'GET', flooder, undefined, internal))
          .status,
      };
      // Відмова nginx має ті самі CORS-заголовки, що й відповідь engine для того ж origin:
      // інакше браузерний клієнт бачить мережеву помилку замість 429.
      for (const origin of ['http://localhost:3000', 'https://not-allowed.example']) {
        const headers = { origin };
        const limited = await request(
          '/orders?limit=1',
          'GET',
          flooder,
          undefined,
          engine,
          headers,
        );
        const served = await request('/instruments', 'GET', undefined, undefined, engine, headers);
        await Promise.all([limited.arrayBuffer(), served.arrayBuffer()]);
        cors[origin] = {
          status: limited.status,
          limited: limited.headers.get('access-control-allow-origin'),
          engine: served.headers.get('access-control-allow-origin'),
        };
      }
    });
    assert.deepEqual(probes, { health: 200, book: 200, session: 401 });
    assert.deepEqual(cors, {
      'http://localhost:3000': {
        status: 429,
        limited: 'http://localhost:3000',
        engine: 'http://localhost:3000',
      },
      'https://not-allowed.example': { status: 429, limited: null, engine: null },
    });
    assert((counts['200'] ?? 0) + (counts['404'] ?? 0) > 0, 'No read with the token passed');

    // Після потоку квота відновлюється.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await request('/orders?limit=1', 'GET', flooder)).status, 200);

    // Без справжнього токена ліміт на адресу клієнта тримає той самий потік.
    const anonymous = await underFlood('forged');
    assert((anonymous['401'] ?? 0) > 0, 'No read without a valid token reached the engine');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await request('/orders?limit=1', 'GET', flooder)).status, 200);
    // Підроблені ключі не витіснили місця для токена, якого nginx ще не бачив.
    const fresh = await token('register', `${randomUUID()}@system.test`, password);
    assert.equal((await request('/orders?limit=1', 'GET', fresh)).status, 200);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(
      failure,
      ...floods.map((started) => () => started.kill()),
      ...placed.map(
        ([owner, id]) =>
          () =>
            cancelOrder(owner, id),
      ),
    );
  }
}

const [flag, mode, accessToken] = process.argv.slice(2);
void (flag === '--flood' ? flood(mode as 'token' | 'forged', accessToken) : main()).catch(
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
