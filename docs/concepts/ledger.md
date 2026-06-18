# The Ledger

The ledger is Veritrail's single system of record: an append-only, hash-chained
log of validated events. Every capability in the platform — audit, permissions,
spend guard, rollback, forensics, evidence, decision memory, vendor risk — is a
projection over this one chain. Tamper-evidence is a property of the chain
itself, not of any module on top of it.

This document describes the on-disk record shape, how canonicalization and
hashing produce a stable chain, the tamper classes `verifyChain` detects, the
localization property that keeps damage from cascading, optional signing, and
the one honest limitation of an unsigned chain.

Source of record: `packages/core/src/ledger/record.ts`,
`packages/core/src/ledger/integrity.ts`, `packages/core/src/ledger/ledger.ts`,
`packages/core/src/util/canonical.ts`, `packages/core/src/util/hash.ts`.

## The `LedgerRecord`

Each record is one immutable link in the chain
(`packages/core/src/ledger/record.ts`):

```ts
export interface LedgerRecord {
  /** 1-based, contiguous, monotonically increasing sequence number. */
  readonly seq: number;
  /** Unique record id. */
  readonly id: string;
  /** Ledger-assigned receipt time (epoch ms) — the authoritative timestamp. */
  readonly timestamp: number;
  /** The validated event this record commits. */
  readonly event: EventInput;
  /** Hash of the previous record (GENESIS_HASH for the first). */
  readonly prevHash: string;
  /** SHA-256 over the canonical form of the unhashed record. */
  readonly hash: string;
  /** Optional detached signature over `hash`. */
  readonly signature?: string;
  /** Identifier of the key that produced `signature`. */
  readonly signerKeyId?: string;
}
```

The fields covered by the hash are exactly the _unhashed_ record — `seq`, `id`,
`timestamp`, `event`, `prevHash`:

```ts
export interface UnhashedRecord {
  readonly seq: number;
  readonly id: string;
  readonly timestamp: number;
  readonly event: EventInput;
  readonly prevHash: string;
}
```

`hash`, `signature`, and `signerKeyId` are _derived_ and are deliberately **not**
part of the hashed core — hashing the hash would be circular, and the signature
is computed _over_ the hash, so it cannot be an input to it.

### Field provenance

The `Ledger.append` method (`packages/core/src/ledger/ledger.ts`) assigns the
chained fields; the caller never sets them:

- `seq` — `head.seq + 1`, or `1` for the first record.
- `prevHash` — `head.hash`, or `GENESIS_HASH` for the first record.
- `timestamp` — `clock.now()`, the _ledger's_ authoritative receipt time (the
  event's own `occurredAt` is preserved separately inside `event`).
- `id` — minted via `ids.next('evt')`.
- `hash` — `computeRecordHash(unhashed)`.

If an `EventRedactor` is configured, `Ledger.append` applies it after the input
event passes `EventInputSchema` and before any chained field is assigned. The
redacted event is validated again, and only the redacted event is hashed, signed,
and persisted. This keeps sensitive fields out of the committed record without
mutating existing ledger history.

Appends are serialized through a `Mutex`, so the chain is always linear and
gap-free at write time. The persistence port (`EventStore`) independently
re-checks the append-only invariant — a record may only land at `head.seq + 1`
with `prevHash === head.hash`, otherwise the store returns a `CONFLICT`
(`packages/core/src/storage/array-store.ts`).

## Canonicalization

Hashing is only meaningful if the same logical value always serializes to
exactly the same bytes. `JSON.stringify` does **not** guarantee this: object key
order is insertion order, so two structurally-equal objects can stringify
differently. The ledger therefore uses a canonical form
(`packages/core/src/util/canonical.ts`) with two rules:

1. **Lexicographically sorted object keys**, with no insignificant whitespace.
   `{"b":1,"a":2}` and `{"a":2,"b":1}` both canonicalize to `{"a":2,"b":1}`.
2. **Finite numbers only.** `NaN` and `Infinity` have no portable JSON
   representation and would make hashes non-reproducible across runtimes, so
   `canonicalize` throws on them. (The domain schemas also reject non-finite
   numbers up front via `z.number().finite()`.)

Keys whose value is `undefined` are skipped, mirroring `JSON.stringify`, so an
explicit `undefined` and an absent key hash identically.

The hashed core is built by `recordCore`:

```ts
export function recordCore(record: UnhashedRecord): JsonValue {
  return {
    seq: record.seq,
    id: record.id,
    timestamp: record.timestamp,
    prevHash: record.prevHash,
    event: asJson(record.event),
  };
}
```

`asJson` structurally coerces the Zod-validated event into a plain `JsonValue`
(it, too, rejects non-finite numbers). Because canonicalization sorts keys, the
_order_ in which `recordCore` lists its fields is irrelevant to the resulting
hash — it is shown here only for clarity.

## Hashing and the genesis hash

`computeRecordHash` is SHA-256 over the canonical form of the core
(`packages/core/src/util/hash.ts`):

```ts
export function computeRecordHash(record: UnhashedRecord): string {
  return hashJson(recordCore(record)); // sha256Hex(canonicalize(...))
}
```

Because `prevHash` is part of the hashed core, each record's hash transitively
commits to _all_ of its predecessors: change anything in record _n_ and record
_n_'s hash changes; that hash is record _(n+1)_'s `prevHash`, which changes
record _(n+1)_'s hash, and so on. That cascade is what makes the chain
tamper-evident.

The first record has no predecessor, so it chains from the **genesis hash** — a
sentinel of 64 zero hex characters:

```ts
export const GENESIS_HASH = '0'.repeat(64);
```

A valid hash is always a 64-character lowercase hex string (`isHash`).

## The four tamper classes (and the genesis case)

`verifyChain` (`packages/core/src/ledger/integrity.ts`) walks an ordered list of
records and reports every issue it finds. The issue kinds are:

```ts
export type IntegrityIssueKind =
  | 'genesis_mismatch' // the first record does not chain from GENESIS_HASH
  | 'chain_break' // a record's prevHash does not match the previous record's hash
  | 'seq_gap' // sequence numbers are not contiguous and increasing
  | 'hash_mismatch' // a record's stored hash does not match its recomputed hash
  | 'signature_invalid'; // a record's signature does not verify
```

It detects **four classes of tampering**:

| #   | Tamper action                                           | Detected as                                                  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Mutate a record's content                               | `hash_mismatch` — recomputed hash ≠ stored hash              |
| 2   | Re-hash a mutated record but leave its successors alone | `chain_break` — the next record's `prevHash` no longer links |
| 3   | Insert or delete a record                               | `seq_gap` — sequence numbers are no longer contiguous        |
| 4   | Forge a record when signing is enabled                  | `signature_invalid` — signature fails to verify              |

`genesis_mismatch` is the special case of a broken link at the **first** record:
the `prevHash` check fires, and because the record's seq is 1 it is reported as
`genesis_mismatch` rather than `chain_break`:

```ts
if (record.prevHash !== prevHash) {
  issues.push({
    seq: record.seq,
    kind: expectedSeq === 1 ? 'genesis_mismatch' : 'chain_break',
    detail: `prevHash ${record.prevHash} does not link to ${prevHash}`,
  });
}
```

The report itself is:

```ts
export interface IntegrityReport {
  readonly ok: boolean; // true only if there are zero issues
  readonly checked: number; // records examined
  readonly head: string | null; // hash of the last record, or null if empty
  readonly issues: readonly IntegrityIssue[];
}
```

### Per-record checks, in order

For each record, in sequence, `verifyChain`:

1. **Seq check.** If `record.seq !== expectedSeq`, push `seq_gap` and _resync_
   `expectedSeq = record.seq` so downstream links keep being checked rather than
   every subsequent record also failing.
2. **Link check.** If `record.prevHash !== prevHash` (the running expected
   previous hash), push `genesis_mismatch` (when `expectedSeq === 1`) or
   `chain_break`.
3. **Hash check.** Recompute `computeRecordHash(record)`; if it differs from
   `record.hash`, push `hash_mismatch`.
4. **Signature check.** Only when a signer is supplied: missing signatures are
   invalid, and if `signer.verify(record.hash, record.signature, record.signerKeyId)`
   is false, push `signature_invalid`.

Then it advances the running state: `prevHash = record.hash` (the record's
**stored** hash, not the recomputed one) and `expectedSeq += 1`.

## The localization property

Two design choices keep a single act of tampering from being mis-reported as
damage to the entire chain:

- Verification **continues past the first issue** rather than aborting.
- It **chains from each record's stored hash**, not the recomputed one.

The practical consequence:

- **A single content mutation, hash not recomputed** → exactly **one**
  `hash_mismatch`, at the tampered record. Its stored `prevHash` still links to
  its predecessor's stored hash, and the next record's `prevHash` still links to
  the tampered record's _stored_ hash. So the issue is localized to one seq.
- **A mutation where the attacker re-hashes the tampered record** → the
  `hash_mismatch` disappears (stored hash now matches its content), but the
  _next_ record's `prevHash` still points at the old hash, producing one
  `chain_break` at seq _(n+1)_. To hide that, the attacker must re-hash the
  successor too — which moves the break to _(n+2)_, and so on down the chain.

In other words: localized tampering produces a localized, pinpointed report, and
fully hiding a single mutation forces a rewrite of every downstream record.

## Optional signing (forgery resistance)

Hash-chaining makes the ledger tamper-**evident**: you cannot alter history
without breaking the chain. It does not, by itself, stop an attacker who can
_append_ from also recomputing a consistent chain (see the limitation below).
Signing closes that gap by making the ledger tamper-**resistant against
forgery** (`packages/core/src/ports/signer.ts`):

```ts
export interface Signer {
  readonly algorithm: string;
  readonly keyId: string; // recorded alongside the signature
  sign(data: string): string; // detached signature (hex) over `data`
  verify(data: string, signature: string, keyId?: string): boolean;
}
```

The bundled `HmacSigner` is symmetric HMAC-SHA256, suitable when verifiers are
trusted holders of the key:

```ts
const ledger = createInMemoryLedger({ signer: new HmacSigner(secret) });
```

`Ed25519Signer` is asymmetric: it signs with a private key and verifies with
public keys. `RemoteEd25519Signer` delegates signing to a KMS/HSM-style client
while verifying locally. The current signer `keyId` is recorded on each record
as `signerKeyId`; verifiers can keep previous public keys in `trustedPublicKeys`
so records signed before key rotation continue to verify.

When a signer is configured, `append` signs every record's `hash`, stores the
`signature` and `signerKeyId`, and `Ledger.verify()` passes the signer into
`verifyChain`, which verifies each present signature against its `signerKeyId`.
`HmacSigner.verify` uses a constant-time comparison (`timingSafeEqual`) to avoid
leaking via timing, and requires a secret of at least 16 characters.

The default deployment remains unsigned; external anchoring is available through
the core `AnchorStore` port and should be backed by an independent system in
production.

## Honest limitation: a fully-rewritten unsigned chain

An unsigned chain proves **internal consistency**, not **authenticity**. If an
attacker rewrites the _entire_ chain — mutating records and recomputing every
hash from genesis forward — the result is a valid chain by construction.
`verifyChain` will return `ok: true` because there is nothing internally
inconsistent to find.

Two mitigations:

1. **Sign the chain.** A forger without the key cannot produce valid signatures,
   so a rewritten chain fails the `signature_invalid` check.
2. **Anchor externally.** Publish periodic `AnchorRecord` checkpoints through an
   `AnchorStore` backed by an independent system — e.g. a notary, immutable object
   store, or transparency log. `verifyLedgerAgainstLatestAnchor()` verifies the
   chain and compares the latest anchor to the record at the anchored sequence.
   If that record's hash differs, or the record disappeared, the anchored prefix
   was rewritten even if the current chain is internally consistent.

This is called out directly in the `verifyChain` contract:

> A fully-rewritten unsigned chain is internally consistent by construction; to
> detect that, compare the returned `head` against an externally anchored value.

## External anchoring API

Core exposes a small checkpoint abstraction in
`packages/core/src/anchoring/index.ts`:

```ts
export interface AnchorRecord {
  readonly anchorId: string;
  readonly anchoredAt: number;
  readonly seq: number;
  readonly recordId: string;
  readonly headHash: string;
  readonly headTimestamp: number;
  readonly signerKeyId?: string;
  readonly signature?: string;
}

export interface AnchorStore {
  publish(anchor: unknown): Promise<Result<AnchorRecord, VeritrailError>>;
  latest(): Promise<AnchorRecord | null>;
  list(): Promise<AnchorRecord[]>;
}
```

`publishLedgerHeadAnchor({ ledger, store, clock, ids })` reads the current ledger
head and writes an anchor. It returns `NOT_FOUND` for an empty ledger. The helper
copies `signerKeyId` and `signature` from the head when present so the checkpoint
identifies the signed record it committed.

`verifyLedgerAgainstLatestAnchor({ ledger, store })` returns `NOT_FOUND` when no
anchor exists. Otherwise it returns an `AnchorVerificationReport` with the normal
`IntegrityReport` plus anchor-specific issues:

- `chain_invalid` — normal ledger verification failed.
- `anchored_record_missing` — the latest anchor points past the current ledger.
- `anchor_hash_mismatch` — the anchored sequence exists but has a different hash.
- `anchor_record_id_mismatch` — the hash matched but the ledger record id does
  not match the checkpoint.

Verification compares the latest anchor to the record at the anchored `seq`, not
only to the current head. This means records appended after a checkpoint are
valid; they are simply not covered until the next checkpoint is published.

## Worked example

Consider a three-record chain. (Hashes are shown abbreviated; real hashes are
64-char lowercase hex.)

```
seq 1  prevHash = 0000…0000 (GENESIS_HASH)
       event    = { type: 'note', actorId: 'alice', labels: {}, payload: { text: 'start' } }
       hash     = H1 = sha256(canonical({ seq:1, id:'evt_1', timestamp:1000,
                                          prevHash:'0000…0000', event:{…} }))

seq 2  prevHash = H1
       event    = { type: 'note', actorId: 'alice', labels: {}, payload: { text: 'work' } }
       hash     = H2 = sha256(canonical({ seq:2, id:'evt_2', timestamp:1001,
                                          prevHash:H1, event:{…} }))

seq 3  prevHash = H2
       event    = { type: 'note', actorId: 'alice', labels: {}, payload: { text: 'done' } }
       hash     = H3 = sha256(canonical({ seq:3, id:'evt_3', timestamp:1002,
                                          prevHash:H2, event:{…} }))
```

`verifyChain([r1, r2, r3])` → `{ ok: true, checked: 3, head: H3, issues: [] }`.

**Tamper A — mutate seq 2's payload, leave its stored hash.** Change `'work'`
to `'WORK'` but keep `hash = H2`:

- seq 2 recomputes to `H2' ≠ H2` → one `hash_mismatch` at seq 2.
- seq 3's `prevHash` is `H2`, and verification chains from seq 2's _stored_ hash
  (`H2`), so seq 3 still links cleanly. **No** `chain_break`.

Report: `{ ok: false, checked: 3, head: H3, issues: [{ seq: 2, kind: 'hash_mismatch', … }] }`.

**Tamper B — mutate seq 2 _and_ recompute its hash to `H2'`, but do not touch
seq 3.**

- seq 2's stored hash now matches its content → **no** `hash_mismatch`.
- verification advances with `prevHash = H2'`; seq 3's `prevHash` is still `H2`,
  so the link check fails → one `chain_break` at seq 3.

Report: `{ ok: false, …, issues: [{ seq: 3, kind: 'chain_break', … }] }`. To
erase this, the attacker must also re-hash seq 3 — and any record after it.

**Tamper C — delete seq 2.** The list becomes `[r1, r3]`:

- seq 1 verifies.
- the second record has `seq === 3` but `expectedSeq === 2` → `seq_gap` (then
  `expectedSeq` resyncs to 3).
- that record's `prevHash` is `H2`, but the running `prevHash` is `H1` → a
  `chain_break` (its seq is 3, not 1).

Report contains both a `seq_gap` and a `chain_break`.

**Tamper D — full rewrite (unsigned).** The attacker rebuilds all three records
with new content and recomputes `H1', H2', H3'` from genesis:

- every link is consistent, every recomputed hash matches → `{ ok: true, head: H3' }`.

Only signing or comparing `head` to an external anchor reveals this — the
limitation described above.
