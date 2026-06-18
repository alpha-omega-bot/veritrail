# The Event Model

Veritrail has **one** stream. Every fact the platform knows is an event appended
to the single hash-chained ledger; the eight capabilities are projections over
that stream. New capabilities extend the closed set of event types rather than
introducing a parallel store.

This document covers the shared envelope, the full set of event types and their
payloads, how `append` turns an event into a ledger record, and which events each
capability reads and writes.

Source of record: `packages/core/src/domain/event.ts` (event types, envelope,
payloads), `packages/core/src/domain/common.ts` (shared field schemas),
`packages/core/src/ledger/ledger.ts` (`append`).

## The shared envelope

Every event — regardless of type — carries the same envelope
(`packages/core/src/domain/event.ts`):

| Field           | Schema               | Required         | Meaning                                                                                                                                  |
| --------------- | -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`       | `IdSchema`           | yes              | Who/what caused the event.                                                                                                               |
| `correlationId` | `IdSchema`           | optional         | Groups events belonging to the same run / incident / trace.                                                                              |
| `causationId`   | `IdSchema`           | optional         | The id of the action/event that _directly_ caused this one — forms the causal graph the forensics engine replays.                        |
| `labels`        | `LabelsSchema`       | defaults to `{}` | Free-form `string→string` tags used for scoping policies, budgets, and queries.                                                          |
| `occurredAt`    | `TimestampSchema`    | optional         | When it happened in the _source_ system (epoch ms). The ledger separately records its own authoritative receipt timestamp on the record. |
| `type`          | one of `EVENT_TYPES` | yes              | The discriminator.                                                                                                                       |
| `payload`       | per-type (below)     | yes              | The type-specific body.                                                                                                                  |

`IdSchema` is a non-empty, ≤256-char string with no control characters.
`TimestampSchema` is a non-negative integer (epoch ms). `LabelsSchema` is a
record of non-empty-string keys to string values. Every event object is `.strict()`
— unknown keys are a validation error — and the whole input is validated through
`EventInputSchema`, a Zod `discriminatedUnion` on `type`.

```ts
export type EventInput = z.infer<typeof EventInputSchema>;
export type EventOf<T extends EventType> = Extract<EventInput, { type: T }>;
```

## Event types and payloads

`EVENT_TYPES` is the closed set the core understands
(`packages/core/src/domain/event.ts`):

```ts
export const EVENT_TYPES = [
  'action.proposed',
  'action.authorized',
  'action.denied',
  'action.executed',
  'action.failed',
  'action.rolled_back',
  'decision.recorded',
  'evidence.attached',
  'policy.evaluated',
  'budget.charged',
  'budget.exceeded',
  'admin.action',
  'vendor.registered',
  'vendor.signal',
  'note',
] as const;
```

Each row below lists the `payload` shape exactly as defined. All payload objects
are `.strict()`. "default" means the schema fills the value when absent;
"optional" means the field may be omitted entirely.

| Event type           | Payload fields                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action.proposed`    | `action: Action`                                                                                                                                                         |
| `action.authorized`  | `actionId: Id`; `authorizedBy?: Id`; `policyId?: Id`                                                                                                                     |
| `action.denied`      | `actionId: Id`; `reason: string` (default `''`); `policyId?: Id`                                                                                                         |
| `action.executed`    | `actionId: Id`; `outcome: 'success' \| 'partial'` (default `'success'`); `durationMs?: int ≥ 0`; `cost?: Money`; `result?: JsonValue`                                    |
| `action.failed`      | `actionId: Id`; `error: string` (min length 1); `durationMs?: int ≥ 0`                                                                                                   |
| `action.rolled_back` | `actionId: Id`; `compensationActionId?: Id`; `reason: string` (default `''`)                                                                                             |
| `decision.recorded`  | `decision: Decision`                                                                                                                                                     |
| `evidence.attached`  | `evidence: Evidence`                                                                                                                                                     |
| `policy.evaluated`   | `actionId: Id`; `effect: PolicyEffect` (`allow` \| `deny` \| `require_approval`); `matchedPolicyId?: Id`; `reason: string` (default `''`)                                |
| `budget.charged`     | `scope: BudgetScope`; `amount: Money`; `budgetId?: Id`; `actionId?: Id`                                                                                                  |
| `budget.exceeded`    | `budgetId: Id`; `scope: BudgetScope`; `attempted: Money`; `limit: Money`; `actionId?: Id`                                                                                |
| `admin.action`       | `action: string`; `targetType: string`; `targetId?: Id`; `outcome: 'success' \| 'failure'` (default `'success'`); `reason: string` (default `''`); `details?: JsonValue` |
| `vendor.registered`  | `vendor: Vendor`                                                                                                                                                         |
| `vendor.signal`      | `signal: VendorSignal`                                                                                                                                                   |
| `note`               | `text: string` (min length 1); `data?: JsonValue`                                                                                                                        |

### Referenced domain objects

These nested objects (all `.strict()`) come from `packages/core/src/domain/`:

- **`Action`** (`action.ts`): `id`, `actorId`, `type` (namespaced verb,
  1–256 chars), `target` (default `''`), `params: JsonValue` (default `{}`),
  `reversible: boolean` (default `false`), `reversal?: ActionReversal`,
  `cost?: Money`, `risk?: RiskLevel`, `status: ActionStatus` (default
  `'proposed'`), `context: JsonValue` (default `{}`), `createdAt?: Timestamp`.
  `ActionReversal` = `{ strategy: 'compensate'|'restore'|'none', inverse?: { type, target, params }, snapshotRef? }`.
- **`Decision`** (`decision.ts`): `id`, `actorId`, `summary` (1–2000 chars),
  `rationale` (default `''`), `options: DecisionOption[]` (default `[]`),
  `chosen` (default `''`), `evidenceIds: Id[]` (default `[]`),
  `confidence?: number ∈ [0,1]`, `relatedActionIds: Id[]` (default `[]`),
  `createdAt?`.
- **`Evidence`** (`evidence.ts`): `id`, `kind` (`document`|`observation`|
  `tool_output`|`citation`|`dataset`|`artifact`), `source` (default `''`),
  `contentHash?` (64-char hex sha256), `summary` (default `''`), `capturedAt?`,
  `links: { decisionIds[], actionIds[], evidenceIds[] }` (each default `[]`).
- **`Money`** (`common.ts`): `{ currency: <3-letter ISO code>, amountMinor: int }`
  — integer minor units (see ADR 0003).
- **`BudgetScope`** (`budget.ts`): `{ kind: 'global'|'actor'|'label', value: string }`.
- **`PolicyEffect`** (`policy.ts`): `'allow' | 'deny' | 'require_approval'`.
- **`Vendor`** (`vendor.ts`): `id`, `name`, `category`
  (`llm`|`api`|`data`|`infra`|`tooling`|`other`), `criticality` (default
  `'medium'`), `labels`, `createdAt?`.
- **`VendorSignal`** (`vendor.ts`): `id`, `vendorId`, `kind`, `severity`
  (`info`|`low`|`medium`|`high`|`critical`), `summary` (1–2000), `source`
  (default `''`), `observedAt?`.

## From event to record: `append`

`Ledger.append(input: unknown)` (`packages/core/src/ledger/ledger.ts`) is the
only write path. It:

1. **Validates** `input` against `EventInputSchema` (`safeParse`). On failure it
   returns `err(validationError('event failed validation', { issues }))` — no
   throw.
2. If configured, applies the append-boundary `EventRedactor`, then validates the
   redacted event against `EventInputSchema` again. Invalid redaction returns
   `VALIDATION`; redaction failures return `STORAGE`; neither path persists a
   record.
3. **Serializes** the rest under a `Mutex`, so concurrent appends form one linear
   chain.
4. Reads the current `head` and computes the chained fields:
   - `seq = head ? head.seq + 1 : 1`
   - `prevHash = head ? head.hash : GENESIS_HASH`
   - `timestamp = clock.now()` — the ledger's authoritative receipt time
     (distinct from the event's optional `occurredAt`)
   - `id = ids.next('evt')`
5. Computes `hash = computeRecordHash({ seq, id, timestamp, event, prevHash })`.
6. If a signer is configured, sets `signature = signer.sign(hash)` and
   `signerKeyId = signer.keyId`.
7. Persists via `store.append(record)`; a sequencing/linkage violation surfaces
   as a `CONFLICT` result.
8. Returns `ok(record)` with the full `LedgerRecord`.

So the caller controls only the _event_ (envelope + payload); `seq`, `timestamp`,
`hash`, `prevHash`, and `id` are all assigned by the ledger. See
[ledger.md](./ledger.md) for the record shape and integrity model.

### Querying the stream

Reads go through `EventQuery` (`packages/core/src/storage/event-store.ts`),
whose conditions are ANDed: `fromSeq`, `toSeq`, `types`, `actorId`,
`correlationId`, `limit`. Results are always returned in `seq` order. This single
query surface is what every projection below is built on.

## Capability → event map

Each of the eight capabilities is defined entirely by the events it reads from
and writes to this one stream.

| Capability             | Reads                                                                   | Writes                                                                         |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Audit**              | _all_ event types (search, timeline, summary, integrity, NDJSON export) | — (pure projection)                                                            |
| **Permissions**        | — (policies held in memory; `evaluate` is pure)                         | `policy.evaluated`; then `action.authorized` (allow) or `action.denied` (deny) |
| **Spend Guard**        | `budget.charged` (to project current spend)                             | `budget.exceeded` (hard-stop breach); `budget.charged` (recording a charge)    |
| **Rollback**           | `action.proposed` (reversal descriptor), `action.executed` (receipt)    | `action.rolled_back`                                                           |
| **Incident Forensics** | _all_ types within a `correlationId`; walks `causationId` links         | — (read-only projection)                                                       |
| **Evidence Tracing**   | `evidence.attached`                                                     | `evidence.attached`                                                            |
| **Decision Memory**    | `decision.recorded`                                                     | `decision.recorded`                                                            |
| **Vendor Risk**        | `vendor.registered`, `vendor.signal`                                    | `vendor.registered`, `vendor.signal`                                           |

The HTTP server also writes `admin.action` for administrative configuration
changes such as policy and budget updates. That event is a platform audit fact
over the same ledger, not a separate capability store.

A few cross-cutting notes:

- **Correlation is the audit trail key.** Permissions stamps each enforcement
  event with `correlationId = causationId = action.id`, so an action's whole
  governance history (`policy.evaluated` → `action.authorized`/`denied` →
  later `action.executed`/`failed`/`rolled_back`) shares one correlation and is
  recoverable via `query({ correlationId })`.
- **Causation builds the graph forensics replays.** `causeChain` hops from a
  record to the record named by its `event.causationId`, oldest→newest, with a
  cycle guard.
- **No capability owns a private store.** Spend, decisions, evidence, vendors,
  and risk are all _re-derived_ from the ledger on every read, so a module can
  never drift from the system of record.

See [capabilities.md](./capabilities.md) for each module's full public API.
