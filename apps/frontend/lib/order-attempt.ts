import { apiJson, ApiError } from './client-api';
import type { OrderInput } from './decimal';
import { type Order, acceptedOrder, attemptKey } from './private-state';

// sessionStorage може бути недоступний (приватний режим, заблоковані дані сайту).
function readAttempt(key: string) {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as { idempotencyKey: string } | null;
  } catch {
    return null;
  }
}

function writeAttempt(key: string, value: { idempotencyKey: string } | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Без сховища повторна відправка отримає новий ключ — це лише втрата захисту від дубля.
  }
}

export async function sendOrder(input: OrderInput) {
  const key = attemptKey(input);
  const pending = readAttempt(key);
  const idempotencyKey = pending?.idempotencyKey ?? crypto.randomUUID();
  writeAttempt(key, { idempotencyKey });
  try {
    const { order } = await apiJson<{ order: Partial<Order> & { id: string } }>(
      '/api/engine/orders',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
    // Будь-яка успішна відповідь, зокрема 202, означає прийняту заявку. Ключ потрібен лише для
    // повтору після обриву: зі збереженим ключем наступна така сама заявка повернула б цю.
    writeAttempt(key, null);
    return acceptedOrder(input, order);
  } catch (error) {
    // Після обриву або відповіді шлюзу наступний запит має знайти ту саму заявку.
    if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
      writeAttempt(key, null);
    }
    throw error;
  }
}
