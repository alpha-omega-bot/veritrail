# @veritrail/core

The trust core of [Veritrail](../../README.md): a tamper-evident, hash-chained
event ledger plus the domain model the platform's eight governance engines
project over.

## What's here

| Area          | Exports                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| **Ledger**    | `Ledger`, `verifyChain`, `IntegrityReport`, `LedgerRecord`, hashing, snapshot verification           |
| **Domain**    | Zod schemas + types: `Action`, `Decision`, `Evidence`, `Policy`, `Budget`, `Vendor`, `EventInput`, … |
| **Storage**   | `EventStore` port, `InMemoryEventStore`, `FileEventStore`                                            |
| **Ports**     | `Clock`, `IdGenerator`, `Logger`, `Signer` (`HmacSigner`, `Ed25519Signer`)                           |
| **Anchoring** | `AnchorStore`, `InMemoryAnchorStore`, helpers to publish and verify external ledger-head checkpoints |
| **Redaction** | `EventRedactor`, `PathEventRedactor` append-boundary event redaction                                 |
| **Utils**     | `Result`, `VeritrailError`, `canonicalize`, `sha256Hex`                                              |

`FileEventStore` persists ledger records as append-only JSON Lines. Each append
is flushed with file `fsync` before it is acknowledged, and reopening a file with
a torn trailing line recovers and truncates to the last complete committed
record.

## The one idea

Everything that happens — an action proposed, a decision recorded, a budget
charged, a vendor signal observed — is a **validated event appended to a single
append-only ledger**. Each record is hash-chained to its predecessor, so any
mutation, insertion, or deletion is detectable. The eight capabilities (audit,
permissions, spend guard, rollback, forensics, evidence, decision memory, vendor
risk) are _projections and engines over that one stream_, not separate stores.

```ts
import { createInMemoryLedger } from '@veritrail/core';

const ledger = createInMemoryLedger();

await ledger.append({
  type: 'action.executed',
  actorId: 'agent-7',
  correlationId: 'run-42',
  payload: { actionId: 'act-1', outcome: 'success', cost: { currency: 'USD', amountMinor: 120 } },
});

const report = await ledger.verify();
console.log(report.ok, report.head); // true, <chain head hash>
```

## Guarantees & limits

- **Tamper-evident**: `verify()` recomputes every hash and checks every link.
  A single altered record surfaces as one `hash_mismatch`; re-hashing it surfaces
  as a downstream `chain_break`.
- **Snapshot-verifiable**: `Ledger.verifyRecords(records)` verifies an
  already-read record snapshot with the ledger's signer configuration, so
  projections can aggregate and verify the same view.
- **Forgery-resistant (optional)**: provide a `Signer` to sign every record.
  `HmacSigner` supports symmetric deployments; `Ed25519Signer` supports
  asymmetric signing and verification across key rotation via `signerKeyId`.
  `RemoteEd25519Signer` delegates signing to KMS/HSM clients while keeping
  verification local.
- **Anchoring**: a fully-rewritten _unsigned_ chain is internally consistent;
  publish periodic `AnchorRecord` checkpoints through an `AnchorStore` and verify
  them with `verifyLedgerAgainstLatestAnchor()` to detect wholesale rewrites.
- **Append-boundary redaction & encryption**: provide an `EventRedactor` to
  transform a validated event before hashing, signing, and persistence.
  `PathEventRedactor` blanks fields (dot paths and `*` wildcards);
  `EncryptingEventRedactor` (with a `FieldCipher` / `AesGcmKeyring`) encrypts
  fields so PII can be cryptographically erased by destroying the key without
  breaking the chain.
- **Batched ingest**: `Ledger.appendMany(inputs)` commits a contiguous run in one
  store round-trip (a single fsync on `FileEventStore`) while preserving the
  linear, gap-free chain. Stores may implement the optional `EventStore.appendBatch`.

See [`docs/concepts/ledger.md`](../../docs/concepts/ledger.md) for the full model.
