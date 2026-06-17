import { storageError } from '@veritrail/core';

import { postgresDialect } from './dialects.js';
import { RelationalEventStore } from './store.js';
import type {
  SqlConnection,
  SqlDatabase,
  SqlResult,
  SqlRow,
  SqlStatement,
  SqlValue,
} from './sql.js';

export const DEFAULT_POSTGRES_ADVISORY_LOCK_KEY = [0x76657269, 0x74726169] as const;

export type PostgresIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface PostgresQueryResult {
  readonly rows: readonly unknown[];
}

export interface PostgresClient {
  query(sql: string, values?: SqlValue[]): Promise<PostgresQueryResult>;
  release(error?: Error): void;
}

export interface PostgresPool {
  query?(sql: string, values?: SqlValue[]): Promise<PostgresQueryResult>;
  connect(): Promise<PostgresClient>;
}

export interface PostgresDatabaseOptions {
  readonly isolationLevel?: PostgresIsolationLevel;
  readonly advisoryLockKey?: readonly [number, number];
}

export interface PostgresEventStoreOptions extends PostgresDatabaseOptions {
  readonly migrate?: boolean;
}

function values(statement: SqlStatement): SqlValue[] | undefined {
  return statement.values === undefined ? undefined : [...statement.values];
}

function rowsFrom(rows: readonly unknown[]): readonly SqlRow[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw storageError('Postgres driver returned a non-object row', row);
    }
    return row as SqlRow;
  });
}

function asSqlResult(result: PostgresQueryResult): SqlResult {
  return { rows: rowsFrom(result.rows) };
}

function isolationSql(level: PostgresIsolationLevel): string {
  switch (level) {
    case 'read committed':
      return 'READ COMMITTED';
    case 'repeatable read':
      return 'REPEATABLE READ';
    case 'serializable':
      return 'SERIALIZABLE';
  }
}

function validateLockKey(key: readonly [number, number]): readonly [number, number] {
  for (const part of key) {
    if (!Number.isInteger(part) || part < -2147483648 || part > 2147483647) {
      throw storageError('Postgres advisory lock key must contain signed 32-bit integers', {
        key: [...key],
      });
    }
  }
  return key;
}

class PostgresConnection implements SqlConnection {
  readonly #client: PostgresClient;

  constructor(client: PostgresClient) {
    this.#client = client;
  }

  async execute(statement: SqlStatement): Promise<SqlResult> {
    return asSqlResult(await this.#client.query(statement.text, values(statement)));
  }
}

/**
 * `SqlDatabase` wrapper for `pg.Pool`-shaped clients. Append transactions use a
 * serializable transaction plus a transaction-scoped advisory lock by default,
 * which serializes concurrent writers across every process sharing the database.
 */
export class PostgresDatabase implements SqlDatabase {
  readonly #pool: PostgresPool;
  readonly #isolationLevel: PostgresIsolationLevel;
  readonly #advisoryLockKey: readonly [number, number];

  constructor(pool: PostgresPool, options: PostgresDatabaseOptions = {}) {
    this.#pool = pool;
    this.#isolationLevel = options.isolationLevel ?? 'serializable';
    this.#advisoryLockKey = validateLockKey(
      options.advisoryLockKey ?? DEFAULT_POSTGRES_ADVISORY_LOCK_KEY,
    );
  }

  async execute(statement: SqlStatement): Promise<SqlResult> {
    if (this.#pool.query !== undefined) {
      return asSqlResult(await this.#pool.query(statement.text, values(statement)));
    }

    const client = await this.#pool.connect();
    try {
      return asSqlResult(await client.query(statement.text, values(statement)));
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationSql(this.#isolationLevel)}`);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...this.#advisoryLockKey]);
      const value = await fn(new PostgresConnection(client));
      await client.query('COMMIT');
      return value;
    } catch (cause) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the original transaction failure as the reported cause.
      }
      throw cause;
    } finally {
      client.release();
    }
  }
}

export function createPostgresDatabase(
  pool: PostgresPool,
  options: PostgresDatabaseOptions = {},
): PostgresDatabase {
  return new PostgresDatabase(pool, options);
}

export async function createPostgresEventStore(
  pool: PostgresPool,
  options: PostgresEventStoreOptions = {},
): Promise<RelationalEventStore> {
  const { migrate, ...databaseOptions } = options;
  const database = createPostgresDatabase(pool, databaseOptions);
  return RelationalEventStore.open(database, {
    dialect: postgresDialect,
    ...(migrate === undefined ? {} : { migrate }),
  });
}
