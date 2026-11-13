import assert from 'node:assert/strict';
import { adminToken, orders, sendOrder, verifyWorkload, withFreshBook } from './workload';

void withFreshBook(async (db, ledger) => {
  const admin = await adminToken();
  const workload = await orders();
  const first = await Promise.all(workload.map((order) => sendOrder(order, false)));
  // Сплеск 400 заявок упирається в чергу прийому. На повільному CPU частина чекає слота довше
  // 5 с і отримує `ORDERS_BUSY`, тобто не прийнята, тож клієнт повторює тим самим ключем. Інші
  // відмови не повторюються, а кількість зайнятих видно в журналі, щоб помітити втрату запасу.
  const busy = first.filter(({ status, body }) => status === 503 && body.code === 'ORDERS_BUSY');
  console.log(`orders busy on first attempt=${busy.length}/${workload.length}`);
  // Повтор прийнятої заявки повернув би 200 і сховав би відмову після журналу. Робота зайнятого
  // запиту вже завершена, тож журнал тут остаточний.
  const {
    rows: [journaled],
  } = await db.query(
    `SELECT count(*)::int AS count FROM order_requests r
     JOIN order_commands c ON c.order_id=r.order_id AND c.type='submit'
     WHERE r.idempotency_key = ANY($1)`,
    [busy.map(({ key }) => key)],
  );
  assert.equal(journaled.count, 0, 'ORDERS_BUSY returned for a journaled order');
  const retried = new Set(busy.map(({ key }) => key));
  const receipts = await Promise.all(
    workload.map((order, i) => (retried.has(order.key) ? sendOrder(order, true) : first[i])),
  );
  await verifyWorkload(db, ledger, admin, receipts, workload);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
