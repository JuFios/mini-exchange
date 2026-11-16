import { Pool, PoolClient } from 'pg';
import { DataSource, EntityManager } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';

export type DatabaseQuery = Pick<EntityManager, 'query'>;

export function boundedRead<T>(
  source: DataSource,
  signal: AbortSignal,
  work: (db: DatabaseQuery) => Promise<T>,
): Promise<T> {
  return boundedTransaction(source, signal, work, true);
}

/** Дедлайн знищує зайнятий PG-клієнт, тому завислий TCP не утримує слот після відмови. */
export async function boundedTransaction<T>(
  source: DataSource,
  signal: AbortSignal,
  work: (db: DatabaseQuery) => Promise<T>,
  readOnly = false,
): Promise<T> {
  signal.throwIfAborted();
  const pool = (source.driver as PostgresDriver).master as Pool;
  let client: PoolClient | undefined;
  let released = false;
  let broken: Error | undefined;
  const onError = (error: Error) => {
    broken ??= error;
  };
  const release = (destroy = false) => {
    if (!client || released) return;
    released = true;
    if (!destroy && !broken) client.removeListener('error', onError);
    client.release(destroy || broken);
  };
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      release(true);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  const reading = (async () => {
    client = await pool.connect();
    client.on('error', onError);
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await work({
        async query<R>(sql: string, args?: unknown[]): Promise<R> {
          signal.throwIfAborted();
          const result = await client!.query(sql, args);
          // Recovery використовує той самий контракт db.query, що й TypeORM ledger.
          return (
            ['UPDATE', 'DELETE'].includes(result.command)
              ? [result.rows, result.rowCount]
              : result.rows
          ) as R;
        },
      });
      signal.throwIfAborted();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!released)
        await client.query('ROLLBACK').catch(() => {
          broken = new Error('Rollback failed');
        });
      throw error;
    } finally {
      release();
    }
  })();
  try {
    return await Promise.race([reading, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
