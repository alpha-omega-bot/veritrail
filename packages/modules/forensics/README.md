# @veritrail/forensics

Incident Forensics engine for Veritrail — **scaffold baseline**.

A read-only projection over the single tamper-evident `@veritrail/core` ledger.
It reconstructs **incident timelines** and **causal chains** from the event
stream. It owns no separate store: every answer is derived from ledger records on
demand, so it can never drift from the system of record.

## What it does

- **`incident(correlationId)`** — gathers every event sharing a `correlationId`
  (a run / incident / trace) and rolls it up into an `IncidentReport`: a
  seq-ordered timeline, distinct actors (first-seen order), per-type counts,
  failure / denial / rollback tallies, and the first/last timestamps.
- **`timeline(query)`** — projects an arbitrary `EventQuery` into a seq-ordered
  list of compact `TimelineEntry` rows.
- **`causeChain(causationId)`** — walks the causal graph backwards from a record
  via each record's `event.causationId`, returning the chain oldest → newest.
  Missing links and cycles terminate the walk safely.

## Public API

```ts
interface TimelineEntry {
  seq: number;
  at: number;
  type: string;
  actorId: string;
  summary: string;
}

interface IncidentReport {
  correlationId: string;
  entries: TimelineEntry[];
  actors: string[];
  counts: Record<string, number>;
  failures: number;
  denials: number;
  rollbacks: number;
  firstAt: number | null;
  lastAt: number | null;
}

class ForensicsModule implements VeritrailModule {
  readonly info: { name: '@veritrail/forensics'; version: '0.1.0'; capability: 'forensics' };
  constructor(ctx: ModuleContext);
  incident(correlationId: string, opts?: ForensicsProjectionOptions): Promise<IncidentReport>;
  timeline(query: EventQuery): Promise<TimelineEntry[]>;
  causeChain(causationId: string, opts?: ForensicsProjectionOptions): Promise<LedgerRecord[]>;
}

interface ForensicsProjectionOptions {
  /** Restrict the projection to records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

function createForensicsModule(ctx: ModuleContext): ForensicsModule;

// Also exported: summarize(event: EventInput): string
```

Passing `labels` restricts a projection to records carrying exactly those
labels. `incident` then counts and timelines only the in-scope events of the
correlation; `causeChain` walks the causal graph over in-scope records only, so
a hop to an out-of-scope link truncates the chain at the tenant boundary rather
than revealing cross-tenant causation. The server uses these options to enforce
per-tenant API-key label scopes.

## Example

```ts
import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  noopLogger,
} from '@veritrail/core';
import { createForensicsModule } from '@veritrail/forensics';

const ledger = createInMemoryLedger({
  clock: new FixedClock(1_700_000_000_000),
  ids: new SequentialIdGenerator(),
});

await ledger.append({
  type: 'action.proposed',
  actorId: 'agent-1',
  correlationId: 'run-42',
  payload: { action: { id: 'act-1', actorId: 'agent-1', type: 'http.request' } },
});
await ledger.append({
  type: 'action.failed',
  actorId: 'agent-1',
  correlationId: 'run-42',
  payload: { actionId: 'act-1', error: 'timeout' },
});

const forensics = createForensicsModule({
  ledger,
  clock: new FixedClock(1_700_000_000_000),
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
});

const report = await forensics.incident('run-42');
console.log(report.failures); // 1
console.log(report.entries.map((e) => e.summary));
// ['proposed action act-1 (http.request)', 'failed action act-1: timeout']
```

## Phase 1 TODO

- **Anomaly detection** — flag unusual event sequences, error spikes, and
  off-baseline actor behaviour within a correlation.
- **Blast-radius** — compute the set of actions, vendors, and budgets affected by
  a failure by following causal and correlation edges.
- **Snapshot diffs** — reconstruct and diff pre/post state from
  `action.executed` results and rollback snapshot references.
- **Root-cause ranking** — score and order candidate root-cause events in a
  causal chain rather than returning the raw chain.
