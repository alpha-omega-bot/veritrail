# @veritrail/zk-compliance

Predicate-level zero-knowledge proofs over the tamper-evident Veritrail ledger.
Prove to a counterparty that a property holds (e.g. "no PII was leaked outside
the EU in Q3") without revealing the underlying events.

## v0.1 (this release) — Commitment proofs

The prover commits to:

- SHA-256 root of all matching event hashes (sorted)
- Count of matching events
- Hash of the last record in the window (anchor)

Given the trusted ledger head hash and a published predicate, the verifier
recomputes the commitment from their own copy and compares. Mismatch =
proof rejected.

This is "commitment-only": the verifier still needs a copy of the ledger
(or trusts the prover to apply the predicate honestly). It is enough for
most regulatory use cases where the predicate code itself is open.

## v0.2 (planned) — SNARK circuits

Full Risc Zero / Circom circuits proving every event was correctly evaluated.
The verifier no longer needs a ledger copy.

## Use

```ts
import { generateProof, predicateByName, verifyProof } from '@veritrail/zk-compliance';

const predicate = predicateByName('eu-only-region')!;
const proof = await generateProof({
  ledger,
  predicate,
  window: { fromSeq: 1, toSeq: 10_000 },
});

// Ship `proof` to a counterparty. They verify against their ledger copy:
const result = await verifyProof({ proof, predicate, ledger: counterpartyLedger });
if (result.ok) console.log('proof verified');
else console.error('rejected:', result.reasons);
```

## Built-in predicates

- `eu-only-region` — every event has `labels.region === 'EU'`
- `no-pii` — no event has `labels.pii === 'true'`
- `all-decisions-have-rationale` — every `decision.recorded` includes a
  non-empty rationale

Add your own with `{ name, description, predicate }`.

## When to use this vs Receipts

- **Receipts** (`@veritrail/receipt`) prove a single event existed.
- **ZK proofs** prove a property holds across many events without revealing them.
