/** Курсор сторінки `GET /orders`: base64url від JSON з `createdAt` і `id` останнього рядка. */
export function orderCursor({ createdAt, id }: { createdAt: string; id: string }) {
  return btoa(JSON.stringify({ createdAt, id }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Усі активні заявки сторінками за курсором. Без файлів React і шляхів frontend: ту саму
 * процедуру виконує system-тест проти справжнього API.
 */
export async function readActiveOrders<T extends { createdAt: string; id: string }>(
  read: (query: string) => Promise<T[]>,
  limit = 100,
): Promise<T[]> {
  const orders: T[] = [];
  let cursor = '';
  for (;;) {
    const page = await read(`status=active&limit=${limit}` + (cursor ? '&cursor=' + cursor : ''));
    const last = page.at(-1);
    if (!last) return orders;
    orders.push(...page);
    const next = orderCursor(last);
    if (next === cursor) throw new Error('Order cursor did not advance');
    cursor = next;
  }
}
