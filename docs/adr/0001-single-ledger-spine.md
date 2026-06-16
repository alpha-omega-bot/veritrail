# ADR 0001: A single append-only hash-chained ledger as the system of record

- **Status:** Accepted
- **Date:** 2025
- **Deciders:** Veritrail core team

## Context

Veritrail unifies eight governance capabilities for AI agents: audit,
permissions, spend guard, rollback, incident forensics, evidence tracing,
decision memory, and vendor risk. Each capability needs to know _what happened_:
which actions were proposed and executed, which were denied, what was spent, what
was decided and why, what evidence supported it, and what risk signals arrived.

The naïve design gives each capability its own store and schema. That produces
eight sources of truth that can disagree: the audit log might say an action ran
while the spend ledger never recorded its cost; a rollback might reverse an
action the forensics view never saw. Reconciling N stores is an O(N²) integration
problem, and _trust_ — the product's whole premise — degrades to "trust whichever
store you happened to query."

The capabilities also share a single underlying narrative: a stream of facts
about agents acting in the world, ordered in time. That is exactly the shape of
an event log.

## Decision

There is **one** system of record: a single, append-only, hash-chained ledger of
validated events. Concretely:

- Every fact is an `EventInput` (a closed, Zod-validated discriminated union of
  event types) appended via `Ledger.append`
  (`packages/core/src/ledger/ledger.ts`). Appends are serialized through a mutex
  so the chain is always linear and gap-free.
- Each record links to its predecessor by hash (`prevHash`), and its own `hash`
  is SHA-256 over the canonical form of `{ seq, id, timestamp, event, prevHash }`.
  The chain is therefore tamper-evident; `verifyChain` detects content mutation,
  re-hashing, insertion/deletion, and (when signed) forgery. See
  [../concepts/ledger.md](../concepts/ledger.md).
- Persistence is behind an `EventStore` port with in-memory and JSON-Lines file
  adapters; adapters enforce the append-only invariant independently of the
  ledger.
- **Every capability is a projection over this one stream.** Modules receive a
  shared `ModuleContext` carrying the same `Ledger`. Read-only capabilities
  (audit, forensics) only project; write capabilities (permissions, spend guard,
  rollback, evidence, decision memory, vendor risk) append _new facts_ rather
  than mutating any private store. New capabilities extend the event-type union;
  they do not introduce a parallel store.

## Consequences

### Positive

- **One source of truth.** Capabilities cannot disagree, because they read the
  same records. Spend, decisions, and risk are _re-derived_ on every read, so a
  module can never drift from history.
- **Tamper-evidence is global, not per-feature.** Integrity is a property of the
  chain, so it covers every capability at once, and a single `verify()` attests
  the whole system.
- **Auditability for free.** The audit module is a thin projection; the on-disk
  JSON-Lines form is `tail -f`-able and `JSON.parse`-able line by line.
- **Time-travel and replay.** `Ledger.replay` folds a reducer over history, so
  any projection can be rebuilt deterministically, and forensics can walk causal
  chains via `causationId`.
- **Uniform extension model.** Adding a capability is "define events + write a
  projection," not "stand up a new datastore."

### Negative / costs

- **Read amplification.** Projections re-scan the stream (filtered by
  `EventQuery`) on each call. At small/medium scale this is fine; large ledgers
  will need indexed adapters and/or materialized projections. The `EventStore`
  port is designed to absorb this (a SQLite/Postgres adapter is on the roadmap).
- **No in-place edits.** Corrections are new compensating events, not mutations.
  This is the correct behavior for an audit system but requires consumers to read
  "latest by id" semantics (as evidence/decision-memory `get` already do).
- **Append-only growth.** The log only grows; retention/compaction is a future
  concern.
- **Single-writer serialization.** The mutex makes appends linear, which bounds
  write throughput per ledger instance.

## Alternatives considered

1. **Per-capability stores.** Rejected: N sources of truth, O(N²) reconciliation,
   no global integrity story — the exact problem the product exists to solve.
2. **A relational schema with foreign keys (no hash chain).** Gives joins and
   integrity _constraints_, but not tamper-_evidence_: a privileged writer can
   silently edit history. We can still add a relational adapter _under_ the
   `EventStore` port for query performance while keeping the hash chain as the
   trust mechanism.
3. **An external event-streaming platform (e.g. a log broker).** Heavy
   operational dependency for a library that aims to be self-hostable with no
   native dependencies; also does not by itself provide per-record hash chaining
   or canonical hashing. The port abstraction leaves this open as an adapter.
4. **Blockchain / distributed ledger.** Massive overhead for a single-tenant
   control plane. We adopt the useful core idea — a hash chain — and add optional
   signing plus (roadmap) external anchoring, without consensus machinery.
