import type { DatabaseSync } from 'node:sqlite';

let savepointCounter = 0;

/**
 * Wrap `fn` so each call runs atomically: it commits when `fn` returns and
 * rolls back when it throws, rethrowing the error. A call made while a
 * transaction is already open runs in a savepoint instead, so it can nest
 * inside a caller's transaction and roll back on its own.
 *
 * `fn` must be synchronous: the transaction ends when it returns.
 */
export function transaction<Args extends unknown[], Result>(
  database: DatabaseSync,
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args: Args) => {
    const nested = database.isTransaction;
    const savepoint = `jamcoda_tx_${++savepointCounter}`;
    database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    try {
      const result = fn(...args);
      database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
      } else if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      throw error;
    }
  };
}
