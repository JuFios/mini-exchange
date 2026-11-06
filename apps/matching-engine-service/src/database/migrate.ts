import { DataSource, MigrationExecutor } from 'typeorm';

export async function migrate(source: DataSource, action: 'run' | 'revert'): Promise<void> {
  const runner = source.createQueryRunner();
  try {
    await runner.startTransaction('READ COMMITTED');
    // Блокуємо читання історії міграцій і DDL однією транзакцією на тому самому з’єднанні.
    await runner.query('SELECT pg_advisory_xact_lock(734021, 1)');
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
