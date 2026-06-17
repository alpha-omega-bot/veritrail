# @veritrail/relational-store

SQL-backed `EventStore` adapter for Veritrail. It implements the same append-only
storage port as `InMemoryEventStore` and `FileEventStore`, but persists records
in a relational table with migrations and transaction-scoped append checks.

The package intentionally does not depend on a concrete database driver. Provide
a small `SqlDatabase` wrapper around SQLite, Postgres, or another SQL client, then
choose the matching dialect.

```ts
import { Ledger } from '@veritrail/core';
import { RelationalEventStore, sqliteDialect } from '@veritrail/relational-store';

const store = await RelationalEventStore.open(db, { dialect: sqliteDialect });
const ledger = new Ledger({ store });
```

## Guarantees

- Appends run inside the provided `transaction` callback.
- The adapter checks `seq === head.seq + 1` and `prevHash === head.hash` before
  inserting.
- `seq`, `id`, and `hash` are protected by relational uniqueness constraints.
- SQLite/Postgres unique-key violations are mapped to `CONFLICT`, which covers
  races where another writer commits after this writer reads the head.
- The full `LedgerRecord` is stored as canonical JSON source data; relational
  columns are derived indexes for reads and conflict constraints.

Concrete driver wrappers must make `transaction` provide the database's
concurrent-writer safety, for example `BEGIN IMMEDIATE` for SQLite or a
serializable transaction / advisory lock for Postgres.
