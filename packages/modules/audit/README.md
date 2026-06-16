# @veritrail/audit

Audit & Integrity engine for Veritrail. A **read-only projection** over the
single tamper-evident, hash-chained ledger (`@veritrail/core`). It does not own
a store — every method reads the same `Ledger` that backs the whole platform,
so the audit trail is always exactly the system of record.

## What it does

- **search / get** — query the ledger with the standard `EventQuery` filter, or
  fetch one record by sequence number.
- **timeline** — all records sharing a `correlationId` (one run/incident/trace),
  in sequence order.
- **verify** — run the ledger's integrity check over the whole chain.
- **summary** — a one-pass `AuditSummary`: total records, chain head, integrity
  status, a histogram of event types, distinct actor count, and first/last
  timestamps.
- **exportNdjson** — the whole ledger as newline-delimited JSON (one record per
  line, sequence order), suitable for offline analysis or external anchoring.

## Public API

```ts
type AuditSummary = {
  totalRecords: number;
  head: string | null;
  integrityOk: boolean;
  countsByType: Record<string, number>;
  actorCount: number;
  firstAt: number | null;
  lastAt: number | null;
};

class AuditModule implements VeritrailModule {
  readonly info: { name: '@veritrail/audit'; version: '0.1.0'; capability: 'audit' };
  constructor(ctx: ModuleContext);
  search(query: EventQuery): Promise<LedgerRecord[]>;
  get(seq: number): Promise<LedgerRecord | null>;
  timeline(correlationId: string): Promise<LedgerRecord[]>;
  verify(): Promise<IntegrityReport>;
  summary(): Promise<AuditSummary>;
  exportNdjson(): Promise<string>;
}

function createAuditModule(ctx: ModuleContext): AuditModule;
```

## Example

```ts
import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  noopLogger,
} from '@veritrail/core';
import { createAuditModule } from '@veritrail/audit';

const clock = new FixedClock(1_700_000_000_000);
const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });

await ledger.append({
  type: 'note',
  actorId: 'agent-a',
  correlationId: 'run-42',
  payload: { text: 'started run' },
});

const audit = createAuditModule({
  ledger,
  clock,
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
});

console.log(await audit.summary());
//   { totalRecords: 1, head: '…', integrityOk: true,
//     countsByType: { note: 1 }, actorCount: 1, firstAt: 1700000000000, lastAt: 1700000000000 }

const trail = await audit.timeline('run-42');
const backup = await audit.exportNdjson(); // one JSON record per line
```

## Notes

- `exportNdjson` produces no trailing newline; each line round-trips via
  `JSON.parse` back into a `LedgerRecord`.
- `summary().head` and `summary().integrityOk` come from the ledger's own
  `verify()` pass, so they reflect tamper-evidence, not just a record count.
