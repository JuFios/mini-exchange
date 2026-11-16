import { adminToken, orders, sendOrder, verifyWorkload, withFreshBook } from './workload';

void withFreshBook(async (db, ledger) => {
  const admin = await adminToken();
  const workload = await orders();
  const first = await Promise.all(workload.map((order) => sendOrder(order, false)));
  // Перевантаження резерву після TX1 може прострочити ключ. Повтор перевіряє старий ключ,
  // а sendOrder видає новий лише після REQUEST_EXPIRED; verifyWorkload перевіряє порожні спроби.
  const busy = first.filter(({ status, body }) => status === 503 && body.code === 'ORDERS_BUSY');
  console.log(`orders busy on first attempt=${busy.length}/${workload.length}`);
  const retried = new Set(
    first
      .filter(
        ({ status, body }) => status === 503 || (status === 409 && body.code === 'REQUEST_EXPIRED'),
      )
      .map(({ key }) => key),
  );
  const receipts = await Promise.all(
    workload.map((order, i) => (retried.has(order.key) ? sendOrder(order, true) : first[i])),
  );
  await verifyWorkload(db, ledger, admin, receipts, workload);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
