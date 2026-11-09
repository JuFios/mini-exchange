import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { container, database, docker, request, submit, token, until } from './helpers';

const ledger = 'http://settlement-service:3002';
const fullBalance = { instrument: 'ABC', side: 'buy', price: 100, quantity: 1000 };

async function newUser(): Promise<string> {
  return token('register', `${randomUUID()}@example.test`, 'system-only-password');
}

function userId(access: string): string {
  return JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).sub;
}

async function usd(access: string) {
  const response = await request('/wallets', 'GET', access, undefined, ledger);
  assert.equal(response.status, 200);
  const balances: { asset: string; available: string; reserved: string }[] = await response.json();
  const balance = balances.find(({ asset }) => asset === 'USD');
  assert(balance);
  return balance;
}

async function open(access: string, order: unknown) {
  const response = await submit(access, order);
  assert([200, 201, 202].includes(response.status), await response.clone().text());
  const { order: row } = await response.json();
  await until(
    async () => {
      const current = await request(`/orders/${row.id}`, 'GET', access);
      assert.equal(current.status, 200);
      return (await current.json()).status as string;
    },
    (status) => status !== 'pending',
  );
  return { id: row.id as string };
}

async function cancel(access: string, id: string) {
  const response = await request(`/orders/${id}`, 'DELETE', access);
  assert([200, 202].includes(response.status), await response.text());
}

async function main() {
  const db = database();
  await db.connect();
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS acquired')).rows[0].acquired,
      'Another system check is already running',
    );
    const access = await newUser();
    const { id } = await open(access, fullBalance);
    assert.equal((await usd(access)).reserved, '100000.0000000000');
    const service = container('settlement-service');
    docker('stop', '--time', '2', service);
    try {
      await cancel(access, id);
      await until(
        async () =>
          (
            await db.query(
              "SELECT reservation_release_due_at IS NOT NULL AS attempted, reservation_released_at FROM outbox WHERE type='order.closed' AND payload->>'orderId'=$1",
              [id],
            )
          ).rows[0],
        (row) => row?.attempted === true && row.reservation_released_at === null,
      );
    } finally {
      docker('start', service);
    }
    await until(
      async () => {
        try {
          return (await request('/health', 'GET', undefined, undefined, ledger)).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
      30000,
    );
    const released = async (orderId: string) =>
      (
        await db.query(
          "SELECT reservation_released_at FROM outbox WHERE type='order.closed' AND payload->>'orderId'=$1",
          [orderId],
        )
      ).rows[0]?.reservation_released_at != null;
    await until(() => released(id), Boolean, 15000);
    assert.deepEqual(await usd(access), {
      asset: 'USD',
      available: '100000.0000000000',
      reserved: '0.0000000000',
    });

    // Повтор після коміту ledger із втраченою відміткою engine.
    await db.query(
      "UPDATE outbox SET reservation_released_at=NULL,reservation_release_due_at=NULL WHERE type='order.closed' AND payload->>'orderId'=$1",
      [id],
    );
    await until(() => released(id), Boolean);
    const second = await open(access, fullBalance);
    await cancel(access, second.id);
    await until(() => released(second.id), Boolean);
    assert.equal((await usd(access)).available, '100000.0000000000');

    const seller = await newUser();
    const buyer = await newUser();
    const sell = await open(seller, { instrument: 'ABC', side: 'sell', price: 100, quantity: 1 });
    const buy = await open(buyer, { instrument: 'ABC', side: 'buy', price: 101, quantity: 2 });
    await cancel(buyer, buy.id);
    await until(() => released(buy.id), Boolean);
    assert.deepEqual(await usd(buyer), {
      asset: 'USD',
      available: '99899.0000000000',
      reserved: '101.0000000000',
    });
    const trade = await db.query(
      'SELECT trade_id, executed_at FROM trades WHERE buyer_order_id=$1 AND seller_order_id=$2',
      [buy.id, sell.id],
    );
    assert.equal(trade.rowCount, 1);
    const internal = process.env.INTERNAL_API_TOKEN;
    assert(internal);
    const settle = await request(
      '/trades/settle',
      'POST',
      undefined,
      {
        tradeId: trade.rows[0].trade_id,
        instrument: 'ABC',
        baseAsset: 'ABC',
        quoteAsset: 'USD',
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        buyerUserId: userId(buyer),
        sellerUserId: userId(seller),
        price: '100.00',
        quantity: '1.00000000',
        buyLimitPrice: '101.00',
        executedAt: trade.rows[0].executed_at.toISOString(),
      },
      ledger,
      { 'x-internal-token': internal },
    );
    assert.equal(settle.status, 200, await settle.clone().text());
    assert.equal((await settle.json()).status, 'applied');
    assert.deepEqual(await usd(buyer), {
      asset: 'USD',
      available: '99900.0000000000',
      reserved: '0.0000000000',
    });
    console.log(
      'Cancellation releases funds after settlement restarts, preserves fill funds, and tolerates replay.',
    );
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
