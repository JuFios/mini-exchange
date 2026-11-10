import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { container, database, docker, request, token, until } from './helpers';

const stream = 'exchange:settlement:{XYZ}';

async function main() {
  const since = new Date().toISOString();
  const db = database();
  await db.connect();
  try {
    const password = randomUUID();
    const sellEmail = `${randomUUID()}@system.test`;
    const buyer = await token('register', `${randomUUID()}@system.test`, randomUUID());
    await token('register', sellEmail, password);
    const seller = await token('login', sellEmail, password);
    const key = randomUUID();
    const tradeInput = { instrument: 'XYZ', price: '10', quantity: '1' };
    const resting = await request('/orders', 'POST', seller, { ...tradeInput, side: 'sell' });
    assert(resting.ok, await resting.clone().text());
    const rest = (await resting.json()) as { order: { id: string } };
    await until(
      async () =>
        (await db.query('SELECT status FROM orders WHERE id=$1', [rest.order.id])).rows[0]?.status,
      (status) => status === 'open',
    );

    const traceId = randomBytes(16).toString('hex');
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
    const incoming = await request(
      '/orders',
      'POST',
      buyer,
      { ...tradeInput, side: 'buy' },
      undefined,
      {
        'idempotency-key': key,
        traceparent,
      },
    );
    assert(incoming.ok, await incoming.clone().text());
    const buy = (await incoming.json()) as { order: { id: string } };

    const command = (
      await db.query('SELECT traceparent FROM order_commands WHERE order_id=$1', [buy.order.id])
    ).rows[0];
    assert.equal(command.traceparent.split('-')[1], traceId);
    const trade = await until<{ trade_id: string; trace_id: string }>(
      async () =>
        (
          await db.query(
            'SELECT trade_id, trace_id FROM trades WHERE buyer_order_id=$1 AND seller_order_id=$2',
            [buy.order.id, rest.order.id],
          )
        ).rows[0],
      Boolean,
    );
    assert.equal(trade.trace_id, traceId);
    const outbox = (
      await db.query(
        "SELECT traceparent FROM outbox WHERE type='trade.executed' AND payload->>'tradeId'=$1",
        [trade.trade_id],
      )
    ).rows[0];
    assert.equal(outbox.traceparent.split('-')[1], traceId);

    const redis = container('redis');
    const redisEntry = await until(() => {
      const entries = JSON.parse(
        docker('exec', redis, 'redis-cli', '--json', 'XRANGE', stream, '-', '+'),
      ) as [string, string[]][];
      return Promise.resolve(
        entries
          .map(([, fields]) => fields)
          .find((fields) => fields[fields.indexOf('envelope') + 1]?.includes(trade.trade_id)),
      );
    }, Boolean);
    assert.equal(redisEntry![redisEntry!.indexOf('traceparent') + 1].split('-')[1], traceId);

    const postgres = container('exchange-db');
    const ledgerTrace = await until(
      () =>
        Promise.resolve(
          docker(
            'exec',
            postgres,
            'psql',
            '-U',
            'ledger',
            '-d',
            'ledger',
            '-Atc',
            `SELECT trace_id FROM journal_entries WHERE trade_id='${trade.trade_id}'`,
          ),
        ),
      Boolean,
    );
    assert.equal(ledgerTrace, traceId);

    const engine = ['matching-engine-1', 'matching-engine-2'].map(container);
    const settlement = container('settlement-service');
    const logs = (id: string) => docker('logs', '--since', since, id);
    const entries = (log: string) =>
      log.split('\n').flatMap((line) => {
        try {
          return [
            JSON.parse(line) as {
              trace_id?: string;
              event?: string;
              tradeId?: string;
              req?: {
                url?: string;
                method?: string;
                headers?: Record<string, string>;
                body?: Record<string, string>;
              };
            },
          ];
        } catch {
          return [];
        }
      });
    const engineLogs = engine.map(logs).join('\n');
    const settlementLogs = logs(settlement);
    const engineEntries = entries(engineLogs);
    const settlementEntries = entries(settlementLogs);
    assert(
      engineEntries.some(
        (entry) =>
          entry.trace_id === traceId && entry.req?.url === '/orders' && entry.req.method === 'POST',
      ),
    );
    assert(
      engineEntries.some(
        (entry) =>
          entry.trace_id === traceId &&
          entry.event === 'engine.trade_executed' &&
          entry.tradeId === trade.trade_id,
      ),
    );
    assert(
      settlementEntries.some(
        (entry) =>
          entry.trace_id === traceId &&
          entry.event === 'settlement.trade' &&
          entry.tradeId === trade.trade_id,
      ),
    );

    const redacted = '[Redacted]';
    assert(
      engineEntries.some(
        (entry) => entry.req?.url === '/auth/login' && entry.req.body?.password === redacted,
      ),
    );
    assert(
      engineEntries.some(
        (entry) => entry.req?.url === '/orders' && entry.req.headers?.authorization === redacted,
      ),
    );
    assert(
      settlementEntries.some(
        (entry) =>
          entry.req?.url === '/internal/reservations' &&
          entry.req.headers?.['x-internal-token'] === redacted,
      ),
    );
    const internal = docker('exec', settlement, 'sh', '-c', 'printf %s "$INTERNAL_API_TOKEN"');
    for (const secret of [password, buyer, seller, internal]) {
      assert(
        secret && !(engineLogs + settlementLogs).includes(secret),
        'A secret was written to the log',
      );
    }
    assert.equal(
      docker('exec', redis, 'sh', '-c', 'unset REDISCLI_AUTH; redis-cli --raw PING').split(' ')[0],
      'NOAUTH',
    );
    console.log(
      `traceId=${traceId} tradeId=${trade.trade_id} persisted=5 pinoStages=3 redactions=3 redisUnauthenticated=denied`,
    );
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
