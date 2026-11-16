import { apiJson, ApiError } from './client-api';
import type { OrderInput } from './decimal';
import { type Order, acceptedOrder, attemptKey } from './private-state';

const memoryAttempts = new Map<string, { idempotencyKey: string }>();

// sessionStorage може бути недоступний (приватний режим, заблоковані дані сайту).
function readAttempt(key: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return value && typeof value.idempotencyKey === 'string'
      ? value
      : (memoryAttempts.get(key) ?? null);
  } catch {
    return memoryAttempts.get(key) ?? null;
  }
}

function writeAttempt(key: string, value: { idempotencyKey: string } | null) {
  if (value) memoryAttempts.set(key, value);
  else memoryAttempts.delete(key);
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Пам’ять вкладки зберігає ключ до підтвердження навіть без sessionStorage.
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
    if (!order || typeof order.id !== 'string' || !order.id)
      throw new Error('Invalid order acknowledgement');
    const accepted = acceptedOrder(input, order);
    if (attemptKey(accepted) !== key)
      throw new Error('Order acknowledgement does not match the request');
    writeAttempt(key, null);
    return accepted;
  } catch (error) {
    // Після обриву або відповіді шлюзу наступний запит має знайти ту саму заявку.
    if (error instanceof ApiError && [400, 409, 422].includes(error.status)) {
      writeAttempt(key, null);
    }
    throw error;
  }
}
