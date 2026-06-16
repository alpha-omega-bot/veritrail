# The Eight Capabilities

Veritrail unifies eight governance capabilities over one ledger. Each is a
module that takes a shared `ModuleContext` and is, at heart, a projection over
the single event stream — some also append new facts.

```ts
// packages/core/src/modules/contracts.ts
export interface ModuleContext {
  readonly ledger: Ledger; // the one system of record, shared by every module
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export type Capability =
  | 'audit'
  | 'permissions'
  | 'spend-guard'
  | 'rollback'
  | 'forensics'
  | 'evidence'
  | 'decision-memory'
  | 'vendor-risk';
```

Centralizing the dependency bundle is deliberate: all modules read/write the
_same_ ledger and observe the _same_ clock — which is what makes the eight
capabilities one coherent system rather than eight independent tools.

**Maturity legend:**

- **GA (v0.1)** — Audit, Permissions, Spend Guard. Production-shaped behavior.
- **Scaffold (working baseline)** — Rollback, Incident Forensics, Evidence
  Tracing, Decision Memory, Vendor Risk. Correct, deterministic baselines with
  deferred Phase-1 work (noted per module).

Every module exposes `readonly info = { name, version: '0.1.0', capability }`.

---

## 1. Audit & Integrity — **GA (v0.1)**

`@veritrail/audit` (`packages/modules/audit/src/index.ts`)

**Purpose.** A pure projection over the ledger: search, fetch, per-correlation
timeline, whole-chain integrity verification, an aggregate summary, and an NDJSON
export for offline analysis or external anchoring. It never keeps its own store.

**Events.** Reads all event types; writes none.

**API.**

```ts
class AuditModule {
  search(query: EventQuery): Promise<LedgerRecord[]>; // ledger.query
  get(seq: number): Promise<LedgerRecord | null>; // ledger.getBySeq
  timeline(correlationId: string): Promise<LedgerRecord[]>;
  verify(): Promise<IntegrityReport>; // delegates to ledger
  summary(): Promise<AuditSummary>;
  exportNdjson(): Promise<string>; // one JSON.stringify(record) per line
}
function createAuditModule(ctx: ModuleContext): AuditModule;
```

`AuditSummary` = `{ totalRecords, head, integrityOk, countsByType, actorCount,
firstAt, lastAt }`, computed in a single pass plus one integrity pass.
`exportNdjson` has no trailing newline; each line round-trips via `JSON.parse`.

---

## 2. Permissions — **GA (v0.1)**

`@veritrail/permissions` (`packages/modules/permissions/src/index.ts`)

**Purpose.** A **deny-by-default** policy engine that gates agent actions.
Evaluation is a pure projection over an in-memory rule set; the decision is then
enforced by appending facts to the ledger. Safe by construction: when no enabled
policy matches, the configured default effect (default `deny`) applies.

**Events.** Writes `policy.evaluated`, then `action.authorized` (on allow) or
`action.denied` (on deny). Reads none from the ledger (policies live in memory).

**API.**

```ts
class PermissionsModule {
  addPolicy(input: unknown): Result<Policy, VeritrailError>; // mints `pol…` id if absent
  removePolicy(id: string): boolean;
  listPolicies(): Policy[]; // priority desc, then effect rank
  evaluate(action: Action, opts?: { actor?: Actor }): PolicyDecision; // PURE, no I/O
  enforce(
    action: Action,
    opts?: { actor?: Actor },
  ): Promise<Result<PolicyDecision, VeritrailError>>;
}
function createPermissionsModule(ctx: ModuleContext, config?: PermissionsConfig): PermissionsModule;
export { globToRegExp, matchesAction };
```

**Resolution.** Among enabled policies whose `match` applies, highest `priority`
wins; ties resolve by effect rank `deny > require_approval > allow`.
`PolicyDecision` = `{ effect, matchedPolicyId?, reason }`. `enforce` always
appends `policy.evaluated`; then:

- `allow` → append `action.authorized` → `ok(decision)`
- `deny` → append `action.denied` → `err(POLICY_DENIED)`
- `require_approval` → append nothing further → `ok(decision)`

Enforcement events are stamped `correlationId = causationId = action.id`.

---

## 3. Spend Guard — **GA (v0.1)**

`@veritrail/spend-guard` (`packages/modules/spend-guard/src/engine.ts`)

**Purpose.** Budget tracking and hard-stop enforcement. Budgets are held in
memory (operator config), but _spend_ is always re-derived from `budget.charged`
events, so the engine is stateless w.r.t. accumulated cost and cannot drift from
the ledger.

**Events.** Reads `budget.charged`; writes `budget.exceeded` (on hard-stop
breach) and `budget.charged` (when recording a charge).

**API.**

```ts
class SpendGuardModule {
  setBudget(input: unknown): Result<Budget, VeritrailError>; // mints `bud…` id if absent
  listBudgets(): Budget[];
  authorize(input: AuthorizeInput): Promise<Result<void, VeritrailError>>; // check, no charge
  charge(input: AuthorizeInput): Promise<Result<LedgerRecord, VeritrailError>>; // authorize + record
  status(): Promise<SpendStatus[]>; // window-aware spend/headroom
}
function createSpendGuardModule(ctx: ModuleContext): SpendGuardModule;
export { WINDOW_MS, windowStart, withinWindow };
```

`AuthorizeInput` = `{ actorId, amount: Money, labels?, actionId? }`.
`SpendStatus` = `{ budget, spent, remaining, exceeded }`.

**Enforcement.** For each matching enabled budget, `authorize` computes
`spent + amount`; reaching the limit exactly is allowed, exceeding it is not.
Hard-stop budgets (`hardStop` default `true`) append `budget.exceeded` and return
`err(BUDGET_EXCEEDED)` (first offender wins); soft budgets are allowed but warned.
A currency mismatch between amount and budget is a `VALIDATION` error. `charge`
records the spend with an `actor` scope so both global and actor budgets accrue
it. Windows (`daily`/`weekly`/`monthly`) are **sliding** fixed-length intervals
ending at `now`, not calendar-aligned; `monthly` is a flat 30 days; `total` has
no lower bound.

---

## 4. Rollback — **Scaffold (working baseline)**

`@veritrail/rollback` (`packages/modules/rollback/src/engine.ts`)

**Purpose.** Build and execute compensating plans to reverse recorded actions. A
projection-plus-writer over the ledger: reads an action's `action.proposed`
reversal descriptor and `action.executed` receipt to plan, then appends
`action.rolled_back` on execution. No parallel store.

**Events.** Reads `action.proposed`, `action.executed`; writes
`action.rolled_back`.

**API.**

```ts
class RollbackModule {
  planForAction(actionId: string): Promise<Result<RollbackPlan, VeritrailError>>;
  planForCorrelation(correlationId: string): Promise<RollbackPlan>; // steps in reverse seq order (LIFO)
  execute(plan: RollbackPlan, executor?: CompensationExecutor): Promise<RollbackResult>;
}
function createRollbackModule(ctx: ModuleContext): RollbackModule;
```

`RollbackPlan` = `{ steps: RollbackStep[], unreversible: string[] }`;
`RollbackStep` = `{ actionId, strategy, inverse?, snapshotRef? }`. `planForAction`
returns `NOT_FOUND` when the action was never proposed; a non-reversible or
not-yet-executed action yields an empty plan listing it in `unreversible`.
`execute` invokes a pluggable `CompensationExecutor` (default: a success no-op
that records intent only); `none` strategies are skipped, executor failures
record a `skipped` outcome and append nothing, successes append
`action.rolled_back` with any `compensationActionId`.

**Maturity.** Correct deterministic baseline; saga/partial-failure semantics,
idempotency, and real executor adapters are deferred to Phase 1.

---

## 5. Incident Forensics — **Scaffold (working baseline)**

`@veritrail/forensics` (`packages/modules/forensics/src/engine.ts`)

**Purpose.** Reconstruct incident timelines and causal chains as read-only
projections. Owns no store; every answer is derived on demand.

**Events.** Reads all types within a correlation; walks `causationId` links.
Writes none.

**API.**

```ts
class ForensicsModule {
  incident(correlationId: string): Promise<IncidentReport>;
  timeline(query: EventQuery): Promise<TimelineEntry[]>;
  causeChain(causationId: string): Promise<LedgerRecord[]>; // oldest -> newest
}
function createForensicsModule(ctx: ModuleContext): ForensicsModule;
export { summarize };
```

`TimelineEntry` = `{ seq, at, type, actorId, summary }`. `IncidentReport`
aggregates a seq-ordered timeline plus rolled-up `counts`, distinct `actors`
(first-seen order), `failures`/`denials`/`rollbacks` counts, and
`firstAt`/`lastAt`. `causeChain` hops record→`event.causationId` with a cycle
guard and missing-link stop, so the result is always finite and acyclic.

---

## 6. Evidence Tracing — **Scaffold (working baseline)**

`@veritrail/evidence` (`packages/modules/evidence/src/index.ts`)

**Purpose.** A content-addressed provenance graph over the ledger. Attaching
evidence appends a fact; every read is a projection. `trace` walks upstream
`links.evidenceIds` as `derived_from` edges; `verifyContent` re-hashes content
against the stored `contentHash` to prove it has not changed.

**Events.** Reads and writes `evidence.attached`.

**API.**

```ts
class EvidenceModule {
  attach(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>; // mints `evd…` id
  list(): Promise<Evidence[]>;
  get(evidenceId: string): Promise<Evidence | null>; // latest by id
  trace(evidenceId: string): Promise<Result<ProvenanceGraph, VeritrailError>>;
  verifyContent(evidenceId: string, content: string): Promise<Result<boolean, VeritrailError>>;
}
function createEvidenceModule(ctx: ModuleContext): EvidenceModule;
```

`attach` separates the ledger envelope's `actorId` (required) and optional
`correlationId` from the evidence body before validating against the strict
`EvidenceSchema`. `trace` is depth-first with a `visited` cycle guard and a depth
cap of 100; it returns `NOT_FOUND` for an unknown root, records edges even to
dangling upstream ids (intent stays visible) but does not create nodes for them.
`verifyContent` returns `NOT_FOUND` when the evidence is missing or has no
`contentHash`, else `ok(sha256Hex(content) === contentHash)`.

---

## 7. Decision Memory — **Scaffold (working baseline)**

`@veritrail/decision-memory` (`packages/modules/decision-memory/src/index.ts`)

**Purpose.** Record _why_ an agent did what it did and recall it later.
Recording appends a fact; reads are projections. No parallel store.

**Events.** Reads and writes `decision.recorded`.

**API.**

```ts
class DecisionMemoryModule {
  record(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>; // mints `dec…` id
  list(opts?: { actorId?: string; limit?: number }): Promise<Decision[]>; // newest first
  get(decisionId: string): Promise<Decision | null>; // latest by id
  recall(query: RecallQuery): Promise<DecisionMatch[]>;
}
function createDecisionMemoryModule(ctx: ModuleContext): DecisionMemoryModule;
```

`RecallQuery` = `{ text?, actorId?, limit? }` (default limit 10).
`DecisionMatch` = `{ decision, score ∈ [0,1] }`. The decision's own `actorId`
becomes the ledger envelope actor, so decisions are queryable by actor.

**Recall** is a deliberately simple lexical ranker: it tokenizes the query
(lowercase, split on non-alphanumerics), scores each decision as
`sharedTokens / max(1, queryTokens)` over `summary + rationale + chosen`, drops
zero-overlap decisions, and sorts by score then recency. Empty query text →
most-recent decisions, each score `1`.

**Maturity.** Phase 1 replaces lexical recall with semantic recall.

---

## 8. Vendor Risk — **Scaffold (working baseline)**

`@veritrail/vendor-risk` (`packages/modules/vendor-risk/src/index.ts`,
`scoring.ts`)

**Purpose.** A third-party inventory with time-decayed risk scoring. Vendors and
signals are appended; scoring, listing, and assessment replay the stream. No
separate store.

**Events.** Reads and writes `vendor.registered` and `vendor.signal`.

**API.**

```ts
class VendorRiskModule {
  register(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>; // mints `ven…` id
  recordSignal(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>; // mints `sig…` id
  listVendors(): Promise<Vendor[]>;
  signalsFor(vendorId: string): Promise<VendorSignal[]>;
  score(vendorId: string): Promise<Result<VendorRiskScore, VeritrailError>>; // NOT_FOUND if unknown
  assess(): Promise<VendorRiskScore[]>; // riskiest first
  ingest(source: MonitorSource): Promise<number>; // poll + record, returns count
}
function createVendorRiskModule(ctx: ModuleContext): VendorRiskModule;
export { bandFor }; // type RiskBand, VendorRiskScore
```

**Scoring** (`scoring.ts`):
`score = criticalityBase + Σ severityWeight(signal) · decay(ageDays)`, with
criticality bases `{low:5, medium:10, high:20, critical:35}`, severity weights
`{info:1, low:2, medium:5, high:10, critical:20}`, and a 30-day half-life
(`0.5^(ageDays/30)`) measured from each signal's ledger timestamp to `now`. The
rounded score maps to a `RiskBand` via `bandFor`: `<20 low`, `<50 medium`,
`<100 high`, else `critical`. `VendorRiskScore` includes the top-3 highest-severity
contributing signals.

`MonitorSource` = `{ name, poll(): Promise<VendorSignal[]> }`; `ingest` records
each polled signal and skips (warns on) invalid ones.
