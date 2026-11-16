/** Курсор сторінки `GET /orders`: base64url від JSON з `createdAt` і `id` останнього рядка. */
export function orderCursor({ createdAt, id }: { createdAt: string; id: string }) {
  return btoa(JSON.stringify({ createdAt, id }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface ActiveOrderScan<T> {
  rows: T[];
  cursor: string;
  complete: boolean;
}

/**
 * Усі активні заявки сторінками за курсором. Без файлів React і шляхів frontend: ту саму
 * процедуру виконує system-тест проти справжнього API.
 */
export async function readActiveOrders<T extends { createdAt: string; id: string }>(
  read: (query: string) => Promise<T[]>,
  limit = 100,
  scan: ActiveOrderScan<T> = { rows: [], cursor: '', complete: false },
): Promise<T[]> {
  while (!scan.complete) {
    const page = await read(
      `status=active&limit=${limit}` + (scan.cursor ? '&cursor=' + scan.cursor : ''),
    );
    const last = page.at(-1);
    if (!last) {
      scan.complete = true;
      break;
    }
    const next = orderCursor(last);
    if (next === scan.cursor) throw new Error('Order cursor did not advance');
    scan.rows.push(...page);
    scan.cursor = next;
  }
  return scan.rows;
}
