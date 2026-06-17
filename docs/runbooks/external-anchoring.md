# External Anchoring Runbook

External anchoring detects a wholesale rewrite of an unsigned ledger by committing
periodic chain-head checkpoints outside the ledger's own storage.

The ledger remains Veritrail's only system of record. Anchors are operational
checkpoints: they do not replace ledger verification and they do not hold domain
facts.

## What to Anchor

Use `publishLedgerHeadAnchor()` from `@veritrail/core`. It reads the current
ledger head and publishes an `AnchorRecord`:

```ts
import {
  publishLedgerHeadAnchor,
  type AnchorStore,
  type Clock,
  type IdGenerator,
  type LedgerReader,
} from '@veritrail/core';

await publishLedgerHeadAnchor({
  ledger,
  store: anchorStore,
  clock,
  ids,
});
```

The checkpoint includes the anchored sequence, record id, head hash, ledger
timestamp, anchor timestamp, and signed-record metadata when present.

## Where to Publish

Production `AnchorStore` implementations should write to an independent,
append-only or immutable system, for example:

- Object storage with bucket versioning, object lock, and cross-account writes.
- A transparency log or public notary service.
- A separate compliance archive controlled by a different administrative domain.

Do not store anchors only in the same database or file path as the ledger. An
attacker who can rewrite both stores can hide the same class of attack anchoring
is meant to expose.

## Cadence

Publish an anchor on a fixed interval and after high-value operations such as
policy changes, incident closure, or large spend events. The shorter the interval,
the smaller the unanchored window.

## Verification

Use `verifyLedgerAgainstLatestAnchor()` during health checks, backups, incident
response, and before exporting evidence:

```ts
import { verifyLedgerAgainstLatestAnchor } from '@veritrail/core';

const result = await verifyLedgerAgainstLatestAnchor({
  ledger,
  store: anchorStore,
});

if (!result.ok) {
  // NOT_FOUND means the deployment has not published an anchor yet.
  throw result.error;
}

if (!result.value.ok) {
  // Treat any issue as a security incident.
  alertSecurity(result.value.issues);
}
```

The verifier first runs normal ledger integrity verification, then compares the
latest anchor to the ledger record at the anchored sequence. Appends after the
checkpoint are valid; they are covered by the next checkpoint. A missing anchored
record, hash mismatch, or chain-integrity failure should be treated as evidence
of tampering until proven otherwise.

## Bootstrap and Recovery

An empty ledger cannot be anchored; `publishLedgerHeadAnchor()` returns
`NOT_FOUND` until at least one record exists.

If verification reports `NOT_FOUND` for the latest anchor, publish an initial
anchor immediately after confirming the chain is valid. If verification reports
an anchor mismatch, stop normal writes, preserve the ledger and anchor store
contents, and investigate from the last known-good backup or exported NDJSON.
