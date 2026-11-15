import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cancelOrder, cleanup, engine, request, submit, token, waitReady } from './helpers';

const internal = 'http://engine-lb:8080';
const instrument = 'XYZ';
const CONNECTIONS = 300;
// За delay=200 до 800 запитів чекають усередині nginx: 300 активних з'єднань вже не
// заповнюють адресний запас 1000. Фаза з різними токенами має перевищити весь запас.
const ACCOUNT_CONNECTIONS = 1500;
const SUBMITS = 30;
// Без потоку заявка проходить за десятки мілісекунд, а без ліміту ~950 скасувань за секунду
// піднімали медіану до ~1,2 с. Межа та сама, що й у сценарії потоку читань.
const P50_BOUND_MS = 200;
const P95_BOUND_MS = 600;
const VICTIM_ADDRESS = '198.51.100.77';
// Адреса з повним запасом для одного імпульсу: її ще не торкались попередні фази.
const PULSE_ADDRESS = '198.51.100.88';
const PULSE = 1000;

type Counts = Record<string, number>;
type Mode = 'delete' | 'replay' | 'accounts' | 'pulse';
type Report = { counts: Counts; elapsedMs: number };

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
  const pulse = mode === 'pulse';
  const loop = async (index: number) => {
    // Обидва listener: на `:8080` без `X-Forwarded-For` ключ — адреса контейнера, як на `:3001`.
    // Імпульс — один запит на з'єднання з однієї нової адреси й різних токенів.
    const base = pulse || index % 2 ? internal : engine;
    const headers: Record<string, string> = pulse ? { 'x-forwarded-for': PULSE_ADDRESS } : {};
    const bearer = tokens[index % tokens.length];
    for (let sent = false; running && !(pulse && sent); sent = true) {
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
            : await request(`/orders/${randomUUID()}`, 'DELETE', bearer, undefined, base, headers);
        await response.arrayBuffer();
        key = String(response.status);
      } catch (error) {
        key = (error as Error).name;
      }
      counts[key] = (counts[key] ?? 0) + 1;
    }
  };
  const started = performance.now();
  process.send!({ type: 'started' });
  const connections = pulse ? PULSE : mode === 'accounts' ? ACCOUNT_CONNECTIONS : CONNECTIONS;
  await Promise.all(Array.from({ length: connections }, (_, index) => loop(index)));
  const elapsedMs = performance.now() - started;
  // Імпульс закінчується сам, але звіт чекає на `stop`, як і безперервний потік.
  if (running) await new Promise((resolve) => process.once('message', resolve));
  process.send!({ type: 'counts', counts, elapsedMs }, () => process.disconnect());
}

function startFlood(mode: Mode, accessTokens: string, replayKey: string) {
  const child: ChildProcess = fork(__filename, ['--flood', mode, accessTokens, replayKey], {
    execArgv: ['--require', 'ts-node/register'],
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', () => undefined);
  const messages = (type: string) =>
    new Promise<Report>((resolve, reject) => {
      child.on('message', (value: { type: string } & Report) => {
        if (value.type === type) resolve(value);
      });
      void exited.then(() => reject(new Error('Flood process exited before reporting')));
    });
  const started = messages('started');
  const report = messages('counts');
  // Після `kill` у прибиранні звіту не буде; відмова не має стати необробленою.
  for (const pending of [started, report]) pending.catch(() => undefined);
  return {
    started,
    async stop(): Promise<Report> {
      const counts = report;
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
    await started.started;
    // Безперервний потік має розігнатися й вичерпати запас, перш ніж міряти заявки іншого
    // користувача. Імпульс міряється з першого запиту: він і є сплеском запасу адреси.
    if (mode !== 'pulse') await new Promise((resolve) => setTimeout(resolve, 3000));
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
    const { counts, elapsedMs } = await started.stop();
    floods.pop();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    // Пропущене nginx не перевищує запасу й поповнення ключа, що обмежує цей режим: токена
    // (100 + 20/с) для одного токена, адреси (1000 + 100/с) для багатьох.
    const passed = total - (counts['429'] ?? 0);
    const [burst, rate] = mode === 'delete' || mode === 'replay' ? [100, 20] : [1000, 100];
    const allowance = (burst + (rate * elapsedMs) / 1000) * 1.1 + 20;
    console.log(
      `orders write flood mode=${mode} passed=${passed} allowance=${allowance.toFixed(0)} ` +
        `elapsed=${elapsedMs.toFixed(0)}ms`,
    );
    assert(passed <= allowance, `${passed} ${mode} writes passed, more than ${allowance}`);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    console.log(
      `orders write flood mode=${mode} writes=${total} ` +
        `statuses=${JSON.stringify(counts)} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`,
    );
    assert(p50 <= P50_BOUND_MS, `Submit p50 ${p50.toFixed(0)} ms under a ${mode} write flood`);
    assert(p95 <= P95_BOUND_MS, `Submit p95 ${p95.toFixed(0)} ms under a ${mode} write flood`);
    const limited = counts['429'] ?? 0;
    if (mode !== 'pulse')
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
    for (let i = 0; i < 100; i++) burst.push((await sell(flooder)).id);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const cancels: Counts = {};
    await Promise.all(
      burst.map(async (id) => {
        const response = await request(`/orders/${id}`, 'DELETE', flooder);
        await response.arrayBuffer();
        cancels[response.status] = (cancels[response.status] ?? 0) + 1;
        // Нескасовану заявку прибере `cleanup`.
        if (response.status === 200)
          placed.splice(
            placed.findIndex(([, placedId]) => placedId === id),
            1,
          );
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

    // Запас адреси одним імпульсом з десяти токенів: nginx пропускає одразу лише частину, решту
    // видає зі швидкістю ліміту, тож чужі заявки під імпульсом не сповільнюються.
    await underFlood('pulse', accounts.slice(0, 10).join(','));
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
