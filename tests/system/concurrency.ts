import { adminToken, orders, sendOrder, verifyWorkload, withFreshBook } from './workload';

void withFreshBook(async (db, ledger) => {
  const admin = await adminToken();
  const workload = await orders();
  const receipts = await Promise.all(workload.map((order) => sendOrder(order, false)));
  await verifyWorkload(db, ledger, admin, receipts);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
