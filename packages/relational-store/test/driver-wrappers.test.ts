import { FixedClock, Ledger, SequentialIdGenerator, type LedgerRecord } from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_ADVISORY_LOCK_KEY,
  PostgresDatabase,
  SqliteDatabase,
  createPostgresEventStore,
  createSqliteEventStore,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type SqliteDriver,
  type SqliteStatement,
  type SqlRow,
  type SqlValue,
} from '../src/index.js';

interface SqlCall {
  readonly text: string;
  readonly values: readonly SqlValue[];
}

class FakeSqlEngine {
  readonly calls: SqlCall[] = [];
  readonly records: LedgerRecord[] = [];

  execute(sql: string, values: readonly SqlValue[] = []): readonly SqlRow[] {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ text, values: [...values] });

    if (
      text.startsWith('BEGIN') ||
      text === 'COMMIT' ||
      text === 'ROLLBACK' ||
      text.startsWith('CREATE ') ||
      text.startsWith('INSERT INTO veritrail_schema_version') ||
      text.startsWith('SELECT pg_advisory_xact_lock')
    ) {
      return [];
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events ORDER BY seq DESC LIMIT 1')) {
      const head = this.records.at(-1);
      return head === undefined ? [] : [{ record_json: JSON.stringify(head) }];
    }

    if (text.startsWith('INSERT INTO veritrail_events')) {
      const recordJson = values[10];
      if (typeof recordJson !== 'string') throw new Error('missing record_json');
      this.records.push(JSON.parse(recordJson) as LedgerRecord);
      this.records.sort((a, b) => a.seq - b.seq);
      return [];
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events WHERE seq =')) {
      const seq = values[0];
      const record = this.records.find((candidate) => candidate.seq === seq);
      return record === undefined ? [] : [{ record_json: JSON.stringify(record) }];
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events ORDER BY seq ASC')) {
      return this.records.map((record) => ({ record_json: JSON.stringify(record) }));
    }

    if (text.startsWith('SELECT COUNT(*) AS count FROM veritrail_events')) {
      return [{ count: this.records.length }];
    }

    throw new Error(`unexpected SQL: ${text}`);
  }

  firstCallIndex(prefix: string): number {
    return this.calls.findIndex((call) => call.text.startsWith(prefix));
  }

  firstCallIndexAfter(prefix: string, after: number): number {
    return this.calls.findIndex((call, index) => index > after && call.text.startsWith(prefix));
  }
}

class FakeSqliteDriver implements SqliteDriver {
  readonly engine = new FakeSqlEngine();

  prepare(sql: string): SqliteStatement {
    return {
      all: (...values) => [...this.engine.execute(sql, values)],
      run: (...values) => {
        this.engine.execute(sql, values);
      },
    };
  }

  exec(sql: string): unknown {
    this.engine.execute(sql);
    return undefined;
  }
}

class FakePostgresClient implements PostgresClient {
  released = false;
  releasedWith: Error | undefined;
  readonly #engine: FakeSqlEngine;

  constructor(engine: FakeSqlEngine) {
    this.#engine = engine;
  }

  async query(sql: string, values: SqlValue[] = []): Promise<PostgresQueryResult> {
    return { rows: this.#engine.execute(sql, values) };
  }

  release(error?: Error): void {
    this.released = true;
    this.releasedWith = error;
  }
}

class FakePostgresPool implements PostgresPool {
  readonly engine = new FakeSqlEngine();
  readonly clients: FakePostgresClient[] = [];

  async query(sql: string, values: SqlValue[] = []): Promise<PostgresQueryResult> {
    return { rows: this.engine.execute(sql, values) };
  }

  async connect(): Promise<PostgresClient> {
    const client = new FakePostgresClient(this.engine);
    this.clients.push(client);
    return client;
  }
}

async function appendNote(ledger: Ledger): Promise<void> {
  const result = await ledger.append({
    type: 'note',
    actorId: 'agent_a',
    payload: { text: 'driver wrapper test' },
  });
  expect(result.ok).toBe(true);
}

describe('SQLite driver wrapper', () => {
  it('opens the writer transaction before reading the ledger head', async () => {
    const driver = new FakeSqliteDriver();
    const store = await createSqliteEventStore(driver);
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });

    await appendNote(ledger);

    expect(await ledger.count()).toBe(1);
    expect((await ledger.verify()).ok).toBe(true);
    const begin = driver.engine.firstCallIndex('BEGIN IMMEDIATE');
    const headRead = driver.engine.firstCallIndexAfter(
      'SELECT record_json FROM veritrail_events ORDER BY seq DESC LIMIT 1',
      begin,
    );
    const insert = driver.engine.firstCallIndex('INSERT INTO veritrail_events');
    const commit = driver.engine.firstCallIndex('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(headRead).toBeGreaterThan(begin);
    expect(insert).toBeGreaterThan(headRead);
    expect(commit).toBeGreaterThan(insert);
  });

  it('rolls back a failed transaction', async () => {
    const driver = new FakeSqliteDriver();
    const database = new SqliteDatabase(driver);
    const failure = new Error('write failed');

    await expect(
      database.transaction(async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(driver.engine.calls.map((call) => call.text)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});

describe('Postgres driver wrapper', () => {
  it('takes a transaction-scoped advisory lock before reading the ledger head', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresEventStore(pool);
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });

    await appendNote(ledger);

    expect(await ledger.count()).toBe(1);
    expect((await ledger.verify()).ok).toBe(true);
    const begin = pool.engine.firstCallIndex('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const lock = pool.engine.firstCallIndex('SELECT pg_advisory_xact_lock');
    const headRead = pool.engine.firstCallIndexAfter(
      'SELECT record_json FROM veritrail_events ORDER BY seq DESC LIMIT 1',
      lock,
    );
    const insert = pool.engine.firstCallIndex('INSERT INTO veritrail_events');
    const commit = pool.engine.firstCallIndex('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(pool.engine.calls[lock]?.values).toEqual([...DEFAULT_POSTGRES_ADVISORY_LOCK_KEY]);
    expect(headRead).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(headRead);
    expect(commit).toBeGreaterThan(insert);
    expect(pool.clients[0]?.released).toBe(true);
  });

  it('rolls back and releases the client on transaction failure', async () => {
    const pool = new FakePostgresPool();
    const database = new PostgresDatabase(pool);
    const failure = new Error('append failed');

    await expect(
      database.transaction(async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(pool.engine.calls.map((call) => call.text)).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'SELECT pg_advisory_xact_lock($1, $2)',
      'ROLLBACK',
    ]);
    expect(pool.clients[0]?.released).toBe(true);
  });
});
