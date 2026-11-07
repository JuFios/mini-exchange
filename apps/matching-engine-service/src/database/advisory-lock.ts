// Усі advisory lock застосунку в одному місці: пара (клас, номер) не повинна повторюватись.
export const advisoryLocks = {
  migrations: { name: 'migrations', key: [734021, 1] },
  adminSeed: { name: 'admin seed', key: [734021, 2] },
} as const;

export type AdvisoryLock = (typeof advisoryLocks)[keyof typeof advisoryLocks];

interface Queryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Бере транзакційний advisory lock і обмежує очікування блокувань у цій транзакції.
 * `lock_timeout` діє й на advisory lock, і на DDL, що чекає на lock таблиці, тож завислий
 * сусід дає зрозумілу помилку замість безстрокового очікування.
 */
export async function lockForTransaction(
  db: Queryable,
  lock: AdvisoryLock,
  timeoutMs: number,
): Promise<void> {
  await db.query("SELECT set_config('lock_timeout', $1, true)", [`${timeoutMs}ms`]);
  try {
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [...lock.key]);
  } catch (error) {
    if (
      (error as { driverError?: { code?: string } }).driverError?.code === LOCK_NOT_AVAILABLE ||
      (error as { code?: string }).code === LOCK_NOT_AVAILABLE
    ) {
      // Початкову помилку зберігаємо в `cause`: ES2022-конструктор недоступний при цільовому target.
      throw Object.assign(
        new Error(`Timed out after ${timeoutMs} ms waiting for the ${lock.name} lock`),
        { cause: error },
      );
    }
    throw error;
  }
}
