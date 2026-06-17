# @veritrail/relational-store

SQL-backed `EventStore` adapter for Veritrail. It implements the same append-only
storage port as `InMemoryEventStore` and `FileEventStore`, but persists records
in a relational table with migrations and transaction-scoped append checks.

The package intentionally does not bundle concrete database drivers. Use the
built-in SQLite/Postgres wrappers with your installed driver, or provide a small
`SqlDatabase` wrapper around another SQL client and choose the matching dialect.

```ts
import { Ledger } from '@veritrail/core';
import { RelationalEventStore, sqliteDialect } from '@veritrail/relational-store';

const store = await RelationalEventStore.open(db, { dialect: sqliteDialect });
const ledger = new Ledger({ store });
```

## SQLite

`SqliteDatabase` wraps synchronous SQLite drivers with a
`better-sqlite3`-shaped API: `prepare(sql).all(...)`, `prepare(sql).run(...)`,
and `exec(sql)`.

```ts
import Database from 'better-sqlite3';
import { Ledger } from '@veritrail/core';
import { createSqliteEventStore } from '@veritrail/relational-store';

const sqlite = new Database('veritrail.db');
const store = await createSqliteEventStore(sqlite);
const ledger = new Ledger({ store });
```

Append transactions use `BEGIN IMMEDIATE` by default. That acquires SQLite's
writer lock before the relational store reads the current ledger head, so
concurrent writers serialize around the append-only check. Operators may opt into
`transactionMode: 'exclusive'` when they need an exclusive database lock.

## Postgres

`PostgresDatabase` wraps `pg.Pool`-shaped clients: `pool.query(...)` for direct
statements and `pool.connect()` for transaction clients with
`query(...)`/`release(...)`.

```ts
import pg from 'pg';
import { Ledger } from '@veritrail/core';
import { createPostgresEventStore } from '@veritrail/relational-store';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = await createPostgresEventStore(pool);
const ledger = new Ledger({ store });
```

Append transactions use `BEGIN ISOLATION LEVEL SERIALIZABLE` and acquire a
transaction-scoped advisory lock before reading the ledger head. The advisory
lock serializes writers across all Veritrail processes sharing the same database.
Use `advisoryLockKey: [int32, int32]` only if multiple independent Veritrail
ledgers intentionally share one Postgres database.

## Guarantees

- Appends run inside the provided `transaction` callback.
- The adapter checks `seq === head.seq + 1` and `prevHash === head.hash` before
  inserting.
- `seq`, `id`, and `hash` are protected by relational uniqueness constraints.
- SQLite/Postgres unique-key violations are mapped to `CONFLICT`, which covers
  races where another writer commits after this writer reads the head.
- The full `LedgerRecord` is stored as canonical JSON source data; relational
  columns are derived indexes for reads and conflict constraints.
