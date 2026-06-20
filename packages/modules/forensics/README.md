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
- **`blastRadius(rootId)`** — the forward complement of `causeChain`: walks
  `causationId` edges _downstream_ from a root event to find everything its
  effects reached, returning a `BlastRadiusReport` (impacted seq-ordered
  timeline, distinct affected actors and correlations, and failure / denial /
  rollback tallies within the radius). Returns `NOT_FOUND` for an unknown root.
- **`rankRootCauses(correlationId)`** — ranks the correlation's failure / denial /
  rollback events worst-first by the size of each one's forward blast radius
  (most downstream impact first), ties broken toward the earliest event. A
  deterministic baseline heuristic, not a causal-inference model.
- **`incidentBundle(correlationId)`** — a shareable package composing the above:
  the `incident` report, the ranked root causes, and the `blastRadius` of the
  top-ranked cause, plus a `generatedAt` stamp. Everything needed to triage and
  hand off an incident in one object.

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

interface BlastRadiusReport {
  rootId: string;
  entries: TimelineEntry[]; // root + causally-downstream events, seq-ordered
  actors: string[]; // distinct affected actors, first-seen order
  correlations: string[]; // distinct correlations touched
  impactedCount: number; // events in the radius excluding the root
  failures: number;
  denials: number;
  rollbacks: number;
}

interface RootCauseCandidate {
  id: string;
  seq: number;
  type: string; // action.failed | action.denied | action.rolled_back
  actorId: string;
  summary: string;
  impactedCount: number; // forward blast radius (downstream events, excl. itself)
}

interface IncidentBundle {
  correlationId: string;
  generatedAt: number;
  incident: IncidentReport;
  rootCauses: RootCauseCandidate[];
  topRootCauseBlastRadius: BlastRadiusReport | null;
}

class ForensicsModule implements VeritrailModule {
  readonly info: { name: '@veritrail/forensics'; version: '0.1.0'; capability: 'forensics' };
  constructor(ctx: ModuleContext);
  incident(correlationId: string, opts?: ForensicsProjectionOptions): Promise<IncidentReport>;
  timeline(query: EventQuery): Promise<TimelineEntry[]>;
  causeChain(causationId: string, opts?: ForensicsProjectionOptions): Promise<LedgerRecord[]>;
  blastRadius(
    rootId: string,
    opts?: ForensicsProjectionOptions,
  ): Promise<Result<BlastRadiusReport, VeritrailError>>;
  rankRootCauses(
    correlationId: string,
    opts?: ForensicsProjectionOptions,
  ): Promise<RootCauseCandidate[]>;
  incidentBundle(correlationId: string, opts?: ForensicsProjectionOptions): Promise<IncidentBundle>;
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
than revealing cross-tenant causation. `blastRadius` likewise only reaches
in-scope downstream records, so the radius truncates at the boundary and a root
outside the scope is `NOT_FOUND`. `rankRootCauses` only considers in-scope
candidates and counts in-scope downstream events. `incidentBundle` scopes every
component the same way. The server uses these options to enforce per-tenant
API-key label scopes.

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
- **Snapshot diffs** — reconstruct and diff pre/post state from
  `action.executed` results and rollback snapshot references.
