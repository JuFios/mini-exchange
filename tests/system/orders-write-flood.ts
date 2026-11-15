import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cancelOrder, cleanup, engine, request, submit, token, waitReady } from './helpers';

const internal = 'http://engine-lb:8080';
const instrument = 'XYZ';
const CONNECTIONS = 300;
const SUBMITS = 30;
// Без потоку заявка проходить за десятки мілісекунд, а без ліміту ~950 скасувань за секунду
// піднімали медіану до ~1,2 с. Межа та сама, що й у сценарії потоку читань.
const P50_BOUND_MS = 200;
const P95_BOUND_MS = 600;
const VICTIM_ADDRESS = '198.51.100.77';

type Counts = Record<string, number>;
type Mode = 'delete' | 'replay' | 'accounts';

const percentile = (values: number[], share: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

/** Потік в окремому процесі, щоб його цикл подій не впливав на виміри заявок. */
async function flood(mode: Mode, accessTokens: string, replayKey: string) {
  // У режимі `accounts` — токени кількох акаунтів однієї адреси через кому.
  const tokens = accessTokens.split(',');
  const counts: Counts = {};
  let running = true;
  process.on('message', () => {
    running = false;
  });
  const loop = async (index: number) => {
    // Обидва listener: на `:8080` без `X-Forwarded-For` ключ — адреса контейнера, як на `:3001`.
    const base = index % 2 ? internal : engine;
    const bearer = tokens[index % tokens.length];
    while (running) {
      let key: string;
      try {
        const response =
          mode === 'replay'
            ? await request(
                '/orders',
                'POST',
                bearer,
                { instrument, side: 'buy', price: '1', quantity: '0.1' },
                base,
                { 'Idempotency-Key': replayKey },
              )
            : await request(`/orders/${randomUUID()}`, 'DELETE', bearer, undefined, base);
        await response.arrayBuffer();
        key = String(response.status);
      } catch (error) {
        key = (error as Error).name;
      }
      counts[key] = (counts[key] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: CONNECTIONS }, (_, index) => loop(index)));
  process.send!(counts, () => process.disconnect());
}

function startFlood(mode: Mode, accessTokens: string, replayKey: string) {
  const child: ChildProcess = fork(__filename, ['--flood', mode, accessTokens, replayKey], {
    execArgv: ['--require', 'ts-node/register'],
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', () => undefined);
  return {
    async stop(): Promise<Counts> {
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
  const newToken = () => token('register', `${randomUUID()}@system.test`, password);
  const victim = await newToken();
  const flooder = await newToken();
  const placed: [string, string][] = [];
  const floods: ReturnType<typeof startFlood>[] = [];
  let failure: unknown;
  let price = 900;

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
    const id = (JSON.parse(text) as { order: { id: string } }).order.id;
    placed.push([owner, id]);
    return { latency, id };
  };

  async function underFlood(mode: Mode, accessTokens: string, replayKey = '') {
    const started = startFlood(mode, accessTokens, replayKey);
    floods.push(started);
    const latencies: number[] = [];
    // Потік має розігнатися й вичерпати запас адреси, перш ніж міряти заявки іншого користувача.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // Жертва з іншої адреси: на `:8080` адресу клієнта передає frontend.
    for (let i = 0; i < SUBMITS; i++) {
      const started = performance.now();
      const response = await request(
        '/orders',
        'POST',
        victim,
        { instrument, side: 'sell', price: String(price++), quantity: '0.1' },
        internal,
        { 'Idempotency-Key': randomUUID(), 'x-forwarded-for': VICTIM_ADDRESS },
      );
      latencies.push(performance.now() - started);
      const text = await response.text();
      assert([201, 202].includes(response.status), `Victim submit: ${response.status} ${text}`);
      placed.push([victim, (JSON.parse(text) as { order: { id: string } }).order.id]);
    }
    const counts = await started.stop();
    floods.pop();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    console.log(
      `orders write flood mode=${mode} connections=${CONNECTIONS} writes=${total} ` +
        `statuses=${JSON.stringify(counts)} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
    );
    assert(p50 <= P50_BOUND_MS, `Submit p50 ${p50.toFixed(0)} ms under a ${mode} write flood`);
    assert(p95 <= P95_BOUND_MS, `Submit p95 ${p95.toFixed(0)} ms under a ${mode} write flood`);
    const limited = counts['429'] ?? 0;
    assert(limited > total / 2, `Only ${limited} of ${total} ${mode} writes were limited`);
    // Після потоку квота відновлюється, і той самий користувач знову подає й скасовує.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const own = await sell(accessTokens.split(',')[0]);
    await cancelOrder(placed.pop()![0], own.id);
    return counts;
  }

  try {
    const baseline: number[] = [];
    for (let i = 0; i < 10; i++) baseline.push((await sell(victim)).latency);
    console.log(`orders write flood baselineP50=${percentile(baseline, 0.5).toFixed(0)}ms`);

    // Сплеск легітимних скасувань: сто власних заявок одночасно вкладаються в запас токена.
    const burst: string[] = [];
    for (let i = 0; i < 100; i++) {
      burst.push((await sell(flooder)).id);
      placed.pop();
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const cancels: Counts = {};
    await Promise.all(
      burst.map(async (id) => {
        const response = await request(`/orders/${id}`, 'DELETE', flooder);
        await response.arrayBuffer();
        cancels[response.status] = (cancels[response.status] ?? 0) + 1;
      }),
    );
    console.log(`orders write flood cancelBurst=${JSON.stringify(cancels)}`);
    assert.deepEqual(cancels, { 200: 100 }, 'A burst of 100 own cancels was limited');
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const deletes = await underFlood('delete', flooder);
    assert((deletes['404'] ?? 0) > 0, 'No cancel with the token reached the engine');

    const replayKey = randomUUID();
    const seeded = await submit(
      flooder,
      { instrument, side: 'buy', price: '1', quantity: '0.1' },
      engine,
      { key: replayKey, retry: false },
    );
    assert.equal(seeded.status, 201, await seeded.clone().text());
    placed.push([flooder, ((await seeded.json()) as { order: { id: string } }).order.id]);
    const replays = await underFlood('replay', flooder, replayKey);
    assert((replays['200'] ?? 0) > 0, 'No replay with the token reached the engine');

    // Нові токени не дають нової квоти: ліміт на адресу тримає потік 20 акаунтів.
    const accounts = await Promise.all(Array.from({ length: 20 }, newToken));
    await underFlood('accounts', accounts.join(','));
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

const [flag, mode, accessTokens, replayKey] = process.argv.slice(2);
void (flag === '--flood' ? flood(mode as Mode, accessTokens, replayKey) : main()).catch(
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
