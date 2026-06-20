# ADR 0006: Batched appends for high-throughput ingest

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Veritrail engineering

## Context

`Ledger.append` serializes every write through a mutex so the chain is always
linear and gap-free: read head, assign `seq`/`prevHash`, hash, sign, persist
([ADR-0001](./0001-single-ledger-spine.md)). For the durable `FileEventStore`
each append also performs an `fsync` before acknowledgement (the correct default
for durability). Under high-throughput ingest this means N concurrent appends
become N serialized round-trips, each paying a full fsync — the D1 throughput
concern in the threat model.

The bottleneck is not the hashing or validation (cheap, CPU-bound) but the
per-record durability barrier. Many records committed in one fsync would cut that
cost by the batch factor while preserving every integrity property.

## Decision

Add an **explicit batch append** that coalesces N records into one store
round-trip, without changing the single-append path or the chain invariant.

1. **Port:** `EventStore` gains an **optional** `appendBatch(records)` method that
   commits a contiguous run atomically (all-or-nothing) and returns the committed
   records or a `CONFLICT`/`STORAGE` error. It is optional so existing adapters
   keep working; callers fall back to sequential `append` when it is absent.

2. **Adapters:** the shared `ArrayBackedEventStore` validates the whole batch
   against the append-only invariant (each record chains to the previous, the
   first chains to the current head) before mutating in-memory state.
   `FileEventStore` serializes all lines and writes them with a **single** `fsync`,
   rolling back (truncate to the pre-batch length) on failure, so a batch is
   durable in full or not at all.

3. **Ledger:** `appendMany(inputs)` validates and redacts every input, then under
   **one** mutex acquisition reads head once, chains the batch
   (`record[i].prevHash = record[i-1].hash`, `seq` contiguous), signs each, and
   persists via `appendBatch` when available (else sequential `append`). It
   returns a `Result` per input position. An input that fails validation/redaction
   is reported at its position and excluded from the committed batch; the
   remaining valid inputs still commit as one contiguous run.

The single-record `append` is unchanged. Batching is opt-in at the call site, so
default behavior and durability semantics are identical.

## Consequences

### Positive

- One fsync per batch instead of per record: ingest throughput scales with batch
  size on the durable store, addressing D1.
- The chain invariant is unchanged — a batch is just a pre-chained contiguous run,
  and `verifyChain` treats it identically to sequentially-appended records.
- Optional port method keeps every existing adapter valid with no change.

### Negative / costs

- Atomic batches are all-or-nothing for durability: a mid-batch store failure
  commits none of the batch (by design), so callers retry the batch.
- Larger batches raise the latency of the slowest record in the batch and the
  memory held before the single flush; callers choose the batch size trade-off.
- A batch shares one mutex acquisition, so a very large batch holds the writer
  longer than a single append; ingest should bound batch size.

## Alternatives considered

1. **Auto-coalescing queue behind `append`.** Transparently batch concurrent
   `append` calls within a time/size window. Rejected as the default: it adds
   hidden latency and complex flush/error semantics to the most trust-sensitive
   path. An explicit `appendMany` keeps the contract obvious; an auto-batching
   wrapper can still be layered on top later.
2. **Group-commit at the store only** (buffer inside `FileEventStore`). Rejected:
   the ledger, not the store, owns sequencing and hashing, so the store cannot
   safely coalesce without re-implementing chain assignment.
3. **Drop per-append fsync for speed.** Rejected: weakens durability, a safe
   default we will not trade for throughput. Batching gives the throughput while
   keeping every record fsync-durable before acknowledgement.
