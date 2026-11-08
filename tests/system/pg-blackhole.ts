import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  container,
  database,
  docker,
  submit,
  token,
  until,
  verifyReplay,
  waitReady,
} from './helpers';

const REPLICAS = ['matching-engine-1', 'matching-engine-2'];
// Сторожовий таймер worker плюс запас на acquire і recovery резервної репліки.
const TAKEOVER_LIMIT_MS = 45000;

const address = (service: string) =>
  docker(
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    container(service),
  );

// Маршрут ставиться лише в мережевому просторі PostgreSQL: Redis лишається доступним власнику.
function route(action: 'add' | 'del', ip: string) {
  docker(
    'run',
    '--rm',
    '--cap-add',
    'NET_ADMIN',
    '--network',
    `container:${container('exchange-db')}`,
    'postgres:16-alpine',
    'ip',
    'route',
    action,
    'blackhole',
    `${ip}/32`,
  );
}

async function main() {
  const db = database();
  await db.connect();
  let cut: string | undefined;
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS acquired')).rows[0].acquired,
      'Another ownership system check is already running',
    );
    // Перерваний попередній запуск міг лишити маршрут.
    for (const service of REPLICAS) {
      try {
        route('del', address(service));
      } catch {
        /* Маршруту немає: звичайний випадок. */
      }
    }
    for (const service of REPLICAS) await waitReady(service);
    const user = await token('register', `${randomUUID()}@system.test`, 'system-user-password');
    const body = { instrument: 'ABC', side: 'sell', price: '100', quantity: '1' };
    assert([200, 201, 202].includes((await submit(user, body)).status));
    const read = async () =>
      (
        await db.query(
          `SELECT owner_instance,owner_epoch,last_applied_seq,
          (SELECT next_seq FROM instruments WHERE symbol='ABC') AS next_seq
          FROM instrument_state WHERE instrument='ABC'`,
        )
      ).rows[0];
    const previous = await until(read, (r) => r.last_applied_seq === r.next_seq);
    const owner = `matching-${previous.owner_instance}`;
    const standby = REPLICAS.find((service) => service !== owner)!;
    cut = address(owner);
    route('add', cut);
    const started = performance.now();
    const current = await until(
      read,
      (r) => BigInt(r.owner_epoch) > BigInt(previous.owner_epoch),
      TAKEOVER_LIMIT_MS,
    );
    const takeoverMs = Math.round(performance.now() - started);
    assert.equal(`matching-${current.owner_instance}`, standby);
    // Через балансувальник: відрізана репліка має дати повторюваний 503, а не 500.
    const response = await submit(user, { ...body, side: 'buy' });
    assert([200, 201, 202].includes(response.status), await response.text());
    await until(read, (r) => r.last_applied_seq === r.next_seq);
    console.log(
      `blackhole oldOwner=${previous.owner_instance} owner=${current.owner_instance} epoch=${current.owner_epoch} takeoverMs=${takeoverMs}`,
    );
    route('del', cut);
    cut = undefined;
    for (const service of REPLICAS) await waitReady(service);
    await verifyReplay(db);
  } finally {
    if (cut) {
      try {
        route('del', cut);
      } catch (error) {
        console.error('Could not remove the blackhole route', error);
        process.exitCode = 1;
      }
    }
    await db.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
