import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cancelOrder, cleanup, engine, request, submit, token, until, waitReady } from './helpers';

const internal = 'http://engine-lb:8080';
const instrument = 'XYZ';
const CONNECTIONS = 300;
const SUBMITS = 30;
// Без потоку заявка проходить за десятки мілісекунд, а без ліміту потік із 300 з'єднань
// піднімав медіану до ~0,5 с. Межа лишає запас для повільного CI, але ловить цю деградацію.
const P50_BOUND_MS = 200;
const P95_BOUND_MS = 600;

type Counts = Record<string, number>;
type Mode = 'token' | 'forged' | 'addresses';

const percentile = (values: number[], share: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

// Рядок у формі JWT з випадковим підписом: для nginx це новий токен на кожен запит.
const forged = () => [12, 48, 32].map((size) => randomBytes(size).toString('base64url')).join('.');
// Нова адреса клієнта для `:8080`, де її задає `X-Forwarded-For`.
const address = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

/** Потік читань в окремому процесі, щоб його цикл подій не впливав на виміри заявок. */
async function flood(mode: Mode, accessToken: string) {
  // У режимі `addresses` — кілька токенів через кому.
  const tokens = accessToken.split(',');
  const counts: Counts = {};
  let running = true;
  process.on('message', () => {
    running = false;
  });
  const loop = async (index: number) => {
    // Обидва слухачі й обидва маршрути читання в кожній комбінації.
    const base = mode === 'addresses' || index % 4 === 0 || index % 4 === 3 ? internal : engine;
    const path = index % 2 ? `/orders/${randomUUID()}` : '/orders?status=all&limit=100';
    while (running) {
      // Підроблені токени чергуються із запитами без токена: обидва не мають ключа токена.
      const bearer =
        mode === 'token'
          ? accessToken
          : mode === 'addresses'
            ? tokens[index % tokens.length]
            : index % 3
              ? forged()
              : undefined;
      const headers: Record<string, string> =
        mode === 'addresses' ? { 'x-forwarded-for': address() } : {};
      let key: string;
      try {
        const response = await request(path, 'GET', bearer, undefined, base, headers);
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

function startFlood(mode: Mode, accessToken: string) {
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

  async function underFlood(mode: Mode, during?: () => Promise<void>, accessToken = flooder) {
    const started = startFlood(mode, accessToken);
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

    // Ліміт на токен окремо від ліміту на адресу: 150 одночасних читань більші за запас токена
    // (100), але менші за запас адреси (500). Пауза між пачками повертає квоту адреси.
    const newToken = () => token('register', `${randomUUID()}@system.test`, password);
    const reads = async (tokens: string[], header = (value: string) => `Bearer ${value}`) => {
      const counts: Counts = {};
      await Promise.all(
        Array.from({ length: 150 }, async (_, index) => {
          const authorization = header(tokens[index % tokens.length]);
          const response = await request('/orders?limit=1', 'GET', undefined, undefined, engine, {
            authorization,
          });
          await response.arrayBuffer();
          counts[response.status] = (counts[response.status] ?? 0) + 1;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return counts;
    };
    const single = await reads([await newToken()]);
    const spread = await reads(await Promise.all([newToken(), newToken(), newToken()]));
    // Жодна форма заголовка, яку приймає engine, не дає пройти понад квоту токена.
    const forms: Record<string, (value: string) => string> = {
      tab: (value) => `Bearer\t${value}`,
      lowercase: (value) => `bearer ${value}`,
      trailing: (value) => `Bearer ${value} trailing`,
      nbsp: (value) => `Bearer\u00a0${value}`,
      leadingNbsp: (value) => `\u00a0Bearer ${value}`,
    };
    const byForm: Record<string, Counts> = {};
    for (const [name, header] of Object.entries(forms))
      byForm[name] = await reads([await newToken()], header);
    console.log(
      `orders read flood tokenLimit single=${JSON.stringify(single)} spread=${JSON.stringify(spread)} ` +
        `forms=${JSON.stringify(byForm)}`,
    );
    assert((single['429'] ?? 0) >= 30, 'The token limit did not refuse reads beyond its burst');
    assert.deepEqual(spread, { 200: 150 }, 'Three tokens must stay below both limits');
    for (const [name, counts] of Object.entries(byForm))
      // Запас 100 плюс поповнення 20/с, поки пачка доходить до nginx на повільному runner.
      assert((counts['200'] ?? 0) <= 120, `Header form ${name} passed ${counts['200']} reads`);

    let probes: Record<string, number> = {};
    let cors: Record<string, unknown> = {};
    // Заголовок із комою чи `|` не має збігтися сам із собою в map nginx.
    const forgedOrigins = [
      'https://not-allowed.example,https://not-allowed.example',
      'https://not-allowed.example|,https://not-allowed.example',
    ];
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
      const origins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://not-allowed.example',
        ...forgedOrigins,
      ];
      for (const origin of origins) {
        const headers = { origin };
        // Квота поповнюється й під потоком, тож окремий запит інколи проходить: беремо відмову.
        const limited = await until(
          async () => {
            const response = await request(
              '/orders?limit=1',
              'GET',
              flooder,
              undefined,
              engine,
              headers,
            );
            if (response.status !== 429) await response.arrayBuffer();
            return response;
          },
          (response) => response.status === 429,
          3000,
        );
        const served = await request('/instruments', 'GET', undefined, undefined, engine, headers);
        await Promise.all([limited.arrayBuffer(), served.arrayBuffer()]);
        cors[origin] = {
          status: limited.status,
          limited: limited.headers.get('access-control-allow-origin'),
          engine: served.headers.get('access-control-allow-origin'),
          vary: limited.headers.get('vary'),
          expose: limited.headers.get('access-control-expose-headers'),
        };
      }
    });
    assert.deepEqual(probes, { health: 200, book: 200, session: 401 });
    const allowed = (origin: string) => ({
      status: 429,
      limited: origin,
      engine: origin,
      vary: 'Origin',
      expose: 'Retry-After',
    });
    assert.deepEqual(cors, {
      'http://localhost:3000': allowed('http://localhost:3000'),
      'http://127.0.0.1:3000': allowed('http://127.0.0.1:3000'),
      ...Object.fromEntries(
        ['https://not-allowed.example', ...forgedOrigins].map((origin) => [
          origin,
          { status: 429, limited: null, engine: null, vary: 'Origin', expose: 'Retry-After' },
        ]),
      ),
    });
    assert((counts['200'] ?? 0) + (counts['404'] ?? 0) > 0, 'No read with the token passed');

    // Після потоку квота відновлюється.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await request('/orders?limit=1', 'GET', flooder)).status, 200);

    // Без справжнього токена ліміт на адресу клієнта тримає той самий потік. Ліміт на адресу
    // нижчий за стелю listener: одна адреса не забирає квоту користувачів з інших адрес.
    const others = await Promise.all(Array.from({ length: 5 }, newToken));
    const othersCounts: Counts = {};
    const anonymous = await underFlood('forged', async () => {
      const until = performance.now() + 3000;
      await Promise.all(
        others.map(async (other, index) => {
          while (performance.now() < until) {
            const started = performance.now();
            const response = await request('/orders?limit=1', 'GET', other, undefined, internal, {
              'x-forwarded-for': `198.51.100.${index + 1}`,
            });
            await response.arrayBuffer();
            othersCounts[response.status] = (othersCounts[response.status] ?? 0) + 1;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, 200 - (performance.now() - started))),
            );
          }
        }),
      );
    });
    const othersTotal = Object.values(othersCounts).reduce((sum, count) => sum + count, 0);
    console.log(`orders read flood othersUnderOneAddress=${JSON.stringify(othersCounts)}`);
    assert((anonymous['401'] ?? 0) > 0, 'No read without a valid token reached the engine');
    assert(
      (othersCounts['200'] ?? 0) >= othersTotal * 0.8,
      'One address took the read quota of users at other addresses',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await request('/orders?limit=1', 'GET', flooder)).status, 200);
    // Підроблені ключі не витіснили місця для токена, якого nginx ще не бачив.
    const fresh = await token('register', `${randomUUID()}@system.test`, password);
    assert.equal((await request('/orders?limit=1', 'GET', fresh)).status, 200);

    // Потік із багатьох адрес і токенів: кожен ключ лишається під своїм лімітом, і без стелі
    // listener engine отримував би всі читання.
    const many = await Promise.all(Array.from({ length: 50 }, newToken));
    await underFlood('addresses', undefined, many.join(','));
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
void (flag === '--flood' ? flood(mode as Mode, accessToken) : main()).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
