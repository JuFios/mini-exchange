import { DataSource, MigrationExecutor } from 'typeorm';
import { advisoryLocks, lockForTransaction } from './advisory-lock';

export interface MigrateOptions {
  /** Скільки чекати блокування: чужу міграцію, advisory lock чи lock таблиці під DDL. */
  lockTimeoutMs?: number;
  /** Ліміт одного SQL-оператора міграції. Довга міграція даних задає свій `SET LOCAL`. */
  statementTimeoutMs?: number;
}

export async function migrate(
  source: DataSource,
  action: 'run' | 'revert',
  { lockTimeoutMs = 60_000, statementTimeoutMs = 300_000 }: MigrateOptions = {},
): Promise<void> {
  const runner = source.createQueryRunner();
  try {
    await runner.startTransaction('READ COMMITTED');
    await runner.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
    // Блокуємо читання історії міграцій і DDL однією транзакцією на тому самому з’єднанні.
    await lockForTransaction(runner, advisoryLocks.migrations, lockTimeoutMs);
    const executor = new MigrationExecutor(source, runner);
    executor.transaction = 'all';
    if (action === 'run') await executor.executePendingMigrations();
    else await executor.undoLastMigration();
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch {
        // Розрив з'єднання вже відкотив транзакцію. Зберігаємо початкову помилку.
      }
    }
    throw error;
  } finally {
    await runner.release();
  }
}
