import { storageError } from '@veritrail/core';

import { sqliteDialect } from './dialects.js';
import { RelationalEventStore } from './store.js';
import type {
  SqlConnection,
  SqlDatabase,
  SqlResult,
  SqlRow,
  SqlStatement,
  SqlValue,
} from './sql.js';

export interface SqliteStatement {
  all(...values: SqlValue[]): unknown[];
  run(...values: SqlValue[]): unknown;
}

export interface SqliteDriver {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
}

export interface SqliteDatabaseOptions {
  readonly transactionMode?: 'immediate' | 'exclusive';
}

export interface SqliteEventStoreOptions extends SqliteDatabaseOptions {
  readonly migrate?: boolean;
}

function values(statement: SqlStatement): SqlValue[] {
  return statement.values === undefined ? [] : [...statement.values];
}

function isReadStatement(text: string): boolean {
  return /^(?:SELECT|WITH|PRAGMA)\b/i.test(text.trimStart());
}

function rowsFrom(rows: readonly unknown[]): readonly SqlRow[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw storageError('SQLite driver returned a non-object row', row);
    }
    return row as SqlRow;
  });
}

/**
 * `SqlDatabase` wrapper for synchronous SQLite drivers with a better-sqlite3
 * shaped API. Write transactions start with `BEGIN IMMEDIATE` by default so the
 * append path takes the SQLite writer lock before reading the ledger head.
 */
export class SqliteDatabase implements SqlDatabase {
  readonly #driver: SqliteDriver;
  readonly #beginStatement: 'BEGIN IMMEDIATE' | 'BEGIN EXCLUSIVE';

  constructor(driver: SqliteDriver, options: SqliteDatabaseOptions = {}) {
    this.#driver = driver;
    this.#beginStatement =
      options.transactionMode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN IMMEDIATE';
  }

  async execute(statement: SqlStatement): Promise<SqlResult> {
    const prepared = this.#driver.prepare(statement.text);
    const args = values(statement);
    if (isReadStatement(statement.text)) {
      return { rows: rowsFrom(prepared.all(...args)) };
    }
    prepared.run(...args);
    return { rows: [] };
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    this.#driver.exec(this.#beginStatement);
    try {
      const value = await fn(this);
      this.#driver.exec('COMMIT');
      return value;
    } catch (cause) {
      try {
        this.#driver.exec('ROLLBACK');
      } catch {
        // Keep the original transaction failure as the reported cause.
      }
      throw cause;
    }
  }
}

export function createSqliteDatabase(
  driver: SqliteDriver,
  options: SqliteDatabaseOptions = {},
): SqliteDatabase {
  return new SqliteDatabase(driver, options);
}

export async function createSqliteEventStore(
  driver: SqliteDriver,
  options: SqliteEventStoreOptions = {},
): Promise<RelationalEventStore> {
  const { migrate, ...databaseOptions } = options;
  const database = createSqliteDatabase(driver, databaseOptions);
  return RelationalEventStore.open(database, {
    dialect: sqliteDialect,
    ...(migrate === undefined ? {} : { migrate }),
  });
}
