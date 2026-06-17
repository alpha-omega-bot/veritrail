# Veritrail Architecture

This document explains how Veritrail is put together and **why**. It is the map
for contributors and the reference for reviewers.

## 1. The central idea: one ledger, eight lenses

Veritrail unifies eight governance capabilities by refusing to build eight stores.
Instead there is **one system of record** — an append-only, hash-chained event
ledger — and every capability is an _engine or projection_ over that single stream
of events.

This is event sourcing applied to agent governance:

- **Audit** is the ledger itself: query + integrity verification + export.
- **Permissions** evaluates policy _before_ an action is authorized, and records
  the `policy.evaluated` / `action.authorized` / `action.denied` facts.
- **Spend Guard** projects cost-bearing events into budgets and enforces limits.
- **Rollback** reads recorded reversible actions and emits compensating facts.
- **Forensics** replays a correlation's events into a timeline and causal graph.
- **Evidence Tracing** projects `evidence.attached` events into a provenance graph.
- **Decision Memory** projects `decision.recorded` events for recall.
- **Vendor Risk** projects `vendor.signal` events into time-decayed risk scores.

Because they share one ledger, the capabilities compose: a forensic timeline can
show the _exact_ policy decision and spend that accompanied a failed action,
because all three are the same events under different lenses.

```
 append (validated)                       project / fold
 ───────────────────►  ┌──────────────┐  ◄───────────────────
   action.executed     │              │     AuditModule.summary()
   policy.evaluated     │   LEDGER    │     SpendGuardModule.status()
   budget.charged       │ (seq, hash, │     ForensicsModule.incident()
   decision.recorded    │  prevHash)  │     VendorRiskModule.assess()
   vendor.signal        │              │     …
                       └──────────────┘
```

## 2. Layering (hexagonal / ports & adapters)

```
        ┌─────────────────────────────────────────────────────────┐
        │  Edges (adapters):   server (HTTP) · cli · sdk · console  │
        └───────────────┬─────────────────────────────────────────┘
                        │ depend on
        ┌───────────────▼─────────────────────────────────────────┐
        │  Modules (engines):  audit · permissions · spend-guard    │
        │                      rollback · forensics · evidence …    │
        └───────────────┬─────────────────────────────────────────┘
                        │ depend on
        ┌───────────────▼─────────────────────────────────────────┐
        │  @veritrail/core:  domain (Zod) · Ledger · ports          │
        │                    storage port + in-memory/file adapters │
        └─────────────────────────────────────────────────────────┘
```

- **Core depends on nothing but `zod` and Node built-ins.** Hashing uses
  `node:crypto`. There is no framework, database driver, or network in the core.
- **I/O is behind ports.** `Clock`, `IdGenerator`, `Logger`, `Signer`, and
  `EventStore` are interfaces. The defaults are pure and in-process; production
  adapters (Postgres, OpenTelemetry, Ed25519/KMS) implement the same ports.
- **Dependencies point inward.** Modules depend on core; edges depend on modules
  and core; core depends on neither. This keeps the trust core small and testable.

## 3. The trust core (`@veritrail/core`)

### 3.1 Domain model

Every domain type is defined **once** as a Zod schema; the TypeScript type is
_inferred_ from it (`z.infer`). This guarantees the compile-time type and the
runtime validator can never drift apart. Entities: `Actor`, `Action`, `Decision`,
`Evidence`, `Policy`, `Budget`, `Vendor`, `VendorSignal`, and the `EventInput`
discriminated union. See [`docs/concepts/event-model.md`](./docs/concepts/event-model.md).

Notable correctness choices:

- **Money is integer minor units** (`{ currency, amountMinor }`) — no floating-point
  drift in financial accumulation. ([ADR-0003](./docs/adr/0003-money-as-integer-minor-units.md))
- **Strict objects** (`.strict()`) reject unknown keys, so typos and injected
  fields fail validation instead of passing silently.
- **Safe defaults in schemas**: budgets `hardStop: true`, actions `reversible:
false`, policies `enabled: true`.

### 3.2 The ledger

A `LedgerRecord` is one link in a chain:

```ts
interface LedgerRecord {
  seq: number; // 1-based, contiguous, monotonic
  id: string;
  timestamp: number; // ledger-assigned receipt time (authoritative)
  event: EventInput; // the validated fact
  prevHash: string; // hash of seq-1 (GENESIS for the first)
  hash: string; // sha256 over canonical({seq,id,timestamp,event,prevHash})
  signature?: string; // optional detached signature over `hash`
  signerKeyId?: string;
}
```

`Ledger.append()`:

1. Validates the event against `EventInputSchema` (returns `VALIDATION` on failure).
2. Serializes appends through a **mutex** so the chain is always linear and gap-free.
3. Reads the head, assigns `seq = head.seq + 1`, `prevHash = head.hash`.
4. Stamps an authoritative `timestamp` from the injected `Clock`.
5. Computes `hash` over the **canonical** JSON of the record (sorted keys, finite
   numbers) so the hash is reproducible regardless of key order.
6. Optionally signs the hash.
7. Persists through the `EventStore`, which independently re-checks the
   append-only invariant (defense in depth).

`Ledger.verify()` recomputes every hash and checks every link, returning an
`IntegrityReport`. It detects four classes of tampering — mutation, re-hash,
insertion/deletion, and (when signing is on) forgery — and **localizes** a single
tampered record rather than cascading the error. The one honest limitation: a
fully-rewritten _unsigned_ chain is internally consistent; detecting that requires
either signing or comparing the head against an external anchor (on the roadmap).
Full detail in [`docs/concepts/ledger.md`](./docs/concepts/ledger.md).

### 3.3 Storage

The `EventStore` port has three reference adapters, all dependency-light:

- `InMemoryEventStore` — volatile, the default for tests and ephemeral use.
- `FileEventStore` — durable, append-only **JSON Lines** (one record per line).
  The on-disk form mirrors the ledger's semantics and is trivially auditable.
- `RelationalEventStore` (`@veritrail/relational-store`) — SQL table storage
  behind a small transaction-capable SQL executor port. It ships SQLite/Postgres
  dialect builders and keeps concrete database drivers out of the trust core.

Concrete SQLite/Postgres driver wrappers and operational migrations remain on
the roadmap; nothing above the port changes when they land.

## 4. The module pattern

Every governance engine implements `VeritrailModule` and is built from a shared
`ModuleContext`:

```ts
interface ModuleContext {
  ledger: Ledger;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}
interface VeritrailModule {
  readonly info: { name: string; version: string; capability: Capability };
}

const audit = createAuditModule(ctx);
const permissions = createPermissionsModule(ctx, { defaultEffect: 'deny' });
```

Centralizing the context is what makes the capabilities _one system_: all modules
read and write the **same** ledger and observe the **same** clock and logger.
Read-only modules depend on the narrower `LedgerReader` interface.

## 5. Edges

- **`@veritrail/server`** — a Fastify HTTP API that constructs one `ModuleContext`,
  mounts every module under `/api/*`, validates request bodies with the same Zod
  schemas, and emits structured logs. Health/readiness endpoints included.
- **`@veritrail/cli`** — an operator CLI (dependency-light, built on
  `node:util.parseArgs`) for ingesting events, verifying integrity, querying the
  ledger, and managing policies/budgets.
- **`@veritrail/sdk`** — a typed client: in-process instrumentation helpers that
  wrap agent actions (propose → check permissions → guard spend → execute →
  record) plus a thin HTTP client for the server.
- **`@veritrail/console`** — a React/Vite read-only dashboard over the server API.

## 6. Cross-cutting concerns

### Error handling

Expected failures are returned as `Result<T, VeritrailError>` with a closed
`code` taxonomy (`VALIDATION`, `INTEGRITY`, `CONFLICT`, `NOT_FOUND`,
`POLICY_DENIED`, `BUDGET_EXCEEDED`, `STORAGE`, `UNSUPPORTED`, `INTERNAL`).
Transports map codes to stable HTTP statuses. Only genuine invariant violations
throw. ([ADR-0002](./docs/adr/0002-result-over-exceptions.md))

### Observability

Logging is a port (`Logger`) with structured fields; the server binds a child
logger per request. Clocks and id generators are injected, so every run is
reproducible and every timestamp is auditable. Metrics/OpenTelemetry adapters are
a port-level addition on the roadmap.

### Determinism & testability

`FixedClock` and `SequentialIdGenerator` make ledgers byte-for-byte reproducible
in tests, which is how the tamper-evidence suite can assert exact hashes.

## 7. Build & tooling

- **pnpm workspaces** monorepo; **TypeScript** strict (incl.
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- Tests resolve packages from **source** (via tsconfig `paths` and Vitest aliases),
  so `pnpm test` and `pnpm typecheck` need no build step.
- **CI** runs format → lint → typecheck → test (coverage) → build on Node 20 & 22,
  plus a dedicated **ledger-integrity gate** and CodeQL. See
  [`.github/workflows`](./.github/workflows).

## 8. Extension points

| You want to…                   | Implement…                                  |
| ------------------------------ | ------------------------------------------- |
| Persist to a database          | `EventStore`                                |
| Sign with KMS / Ed25519        | `Signer`                                    |
| Ship logs/traces to your stack | `Logger`                                    |
| Add a new event type           | extend `EventInputSchema` + a projection    |
| Add a new capability           | a new `@veritrail/*` module over the ledger |
| Feed external vendor risk      | `MonitorSource` (vendor-risk)               |

The rule of thumb: **new capabilities extend the event union and project over the
ledger — they never introduce a parallel source of truth.**
